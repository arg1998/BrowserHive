/** @module app/notifications/producers — the pure producer rules (spec 03 §9.1, D-16, D-32): bus event → notification draft (with its contract content) or a lifecycle revision of an existing thread, or null. */

import { assertNever } from '../../kernel/errors/app-error.ts';
import type { DomainEvent } from '../../ports/event-bus.ts';
import type { DomainEventName, DomainEvents } from '../events/catalog.ts';
import { updatesDraft, updatesRevision } from '../site-packs/update-notifications.ts';
import { time } from './message.ts';
import type { NotificationDraft, ThreadRevision } from './producer-types.ts';
import {
  channelChanged,
  crashed,
  NO_SESSION_LABEL,
  sessionClosed,
  systemDegraded,
  toolCalled,
  toolErrorsTitle,
} from './producers-fleet.ts';
import {
  actorPhrase,
  attentionCreated,
  factsOf,
  requestSettled,
  type SettledRequestFacts,
  vaultConfirmCreated,
} from './producers-requests.ts';
import { writeConfirmDraft, writeConfirmRevision } from './producers-site-packs.ts';
import {
  hostFailedDraft,
  hostRevision,
  reloginFailedDraft,
  signinDraft,
  signinRevision,
  sitesGoneRevision,
  templateGoneRevision,
} from './producers-templates.ts';

export type {
  ImageRequest,
  NotificationDraft,
  NotificationGroup,
  ThreadRevision,
} from './producer-types.ts';
export type { SettledRequestFacts };
export { actorPhrase, crashed, NO_SESSION_LABEL, requestSettled, toolErrorsTitle };

/** A group row stops growing once it has been idle this long (a new failure starts a new row). */
export const NOTIFICATION_GROUP_IDLE_MS = 5 * 60_000;
/** A group row stops growing once it is this old, so a long failing run surfaces again hourly. */
export const NOTIFICATION_GROUP_MAX_AGE_MS = 60 * 60_000;

/** Bus events the producer subscribes to. */
export const PRODUCED_EVENTS = [
  'attention.created',
  'attention.resolved',
  'session.closed',
  'tool.called',
  'vault.confirm.created',
  'vault.confirm.resolved',
  'system.degraded',
  'system.recovered',
  'notification.channel.changed',
  'template.health',
  'template.relogin',
  'template.host',
  'template.changed',
  'template.removed',
  'site_pack.confirm',
  'site_pack.status',
] as const satisfies readonly DomainEventName[];

/** Element of {@link PRODUCED_EVENTS}. */
export type ProducedEventName = (typeof PRODUCED_EVENTS)[number];

/** One published event of a produced name, distributed so `switch (event.name)` narrows the payload. */
export type ProducedEvent = {
  [N in ProducedEventName]: DomainEvent<N, DomainEvents[N]>;
}[ProducedEventName];

/**
 * Applies the producer table to one event.
 *
 * @returns The draft, or `null` for deliberately silent events and for events that only revise an
 * existing notification (see {@link revisionFor}).
 */
export function draftFor(event: ProducedEvent): NotificationDraft | null {
  switch (event.name) {
    case 'attention.created':
      // A security intercept's notice is its template's (`site_pack.write_confirm` from
      // `site_pack.confirm`; a site check is `template.challenged`), never "Attention requested".
      return event.payload.request.kind === 'security_intercept'
        ? null
        : attentionCreated(event.payload);
    case 'site_pack.confirm':
      return writeConfirmDraft(event.payload);
    case 'session.closed':
      return sessionClosed(event.payload);
    case 'tool.called':
      return toolCalled(event.payload);
    case 'vault.confirm.created':
      return vaultConfirmCreated(event.payload);
    case 'system.degraded':
      return systemDegraded(event.payload);
    case 'notification.channel.changed':
      return channelChanged(event.payload);
    case 'template.health':
      return signinDraft(event.payload);
    case 'template.relogin':
      return reloginFailedDraft(event.payload);
    case 'template.host':
      return hostFailedDraft(event.payload);
    case 'site_pack.status':
      return updatesDraft(event.payload);
    case 'attention.resolved':
    case 'vault.confirm.resolved':
    case 'system.recovered':
    case 'template.changed':
    case 'template.removed':
      return null;
    default:
      return assertNever(event);
  }
}

/**
 * Applies the revision table to one event: a resolved request or a recovered degradation revises
 * the notification of its thread (spec 03 §9.1).
 *
 * @returns The revision, or `null` for events that create or say nothing.
 */
export function revisionFor(event: ProducedEvent): ThreadRevision | null {
  switch (event.name) {
    case 'attention.resolved':
      return event.payload.request.kind === 'security_intercept'
        ? null
        : requestSettled('attention', factsOf(event.payload.request));
    case 'site_pack.confirm':
      return writeConfirmRevision(event.payload);
    case 'vault.confirm.resolved':
      return requestSettled('vault', factsOf(event.payload.request));
    case 'system.recovered': {
      const e = event.payload.event;
      return {
        thread: `system:${e.event_id}`,
        dedupKey: `sys-rec:${e.event_id}:${e.resolved_at ?? 0}`,
        change: {
          state: 'resolved',
          summary: `Recovered: ${e.message}`,
          fields:
            e.resolved_at === null ? [] : [{ label: 'Recovered', value: [time(e.resolved_at)] }],
        },
      };
    }
    case 'template.health':
      return signinRevision(event.payload);
    case 'template.host':
      return hostRevision(event.payload);
    case 'template.changed':
      return sitesGoneRevision(event.payload);
    case 'template.removed':
      return templateGoneRevision(event.payload);
    case 'site_pack.status':
      return updatesRevision(event.payload);
    default:
      return null;
  }
}
