/** @module interface/ws/feed — domain bus → topic fan-out, session-update coalescing, auth invalidation and the logs topic (spec 03 §6.6). */

import { SessionId } from '@browserhive/contracts/ids';
import {
  sessionTopic,
  WS_SESSION_TOPIC_EVENTS,
  WS_STATIC_TOPICS,
  WS_TOPIC_EVENTS,
  WsFeedEvent,
} from '@browserhive/contracts/ws';
import type { DomainEvents } from '../../app/events/catalog.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { LogEntry, LogsPort } from '../http/services.ts';
import type { FeedEvent } from './frames.ts';
import type { Schedule } from './live-view.ts';

/** Coalescing window of `session.updated` (spec 03 §6.6). */
export const SESSION_UPDATE_COALESCE_MS = 250;

/** Where the fan-out delivers. */
export interface FeedTarget {
  publish(topic: string, event: FeedEvent): void;
  publishLog(entry: LogEntry): void;
  closeAuthSession(authSessionId: string): void;
}

/** Dependencies of {@link wireFeed}. */
export interface FeedDeps {
  readonly bus: EventBus<DomainEvents>;
  readonly target: FeedTarget;
  readonly logger: Logger;
  readonly schedule: Schedule;
  readonly logs?: LogsPort;
  /** Live view teardown on session end. */
  readonly onSessionClosed?: (sessionId: string, crashed: boolean) => void;
}

/** Static topics carrying each event type. */
export function topicsForEvent(type: string, sessionId: string | null): string[] {
  const topics: string[] = [];
  for (const topic of WS_STATIC_TOPICS) {
    if ((WS_TOPIC_EVENTS[topic] as readonly string[]).includes(type)) topics.push(topic);
  }
  if (sessionId !== null && (WS_SESSION_TOPIC_EVENTS as readonly string[]).includes(type)) {
    const id = SessionId.safeParse(sessionId);
    if (id.success) topics.push(sessionTopic(id.data));
  }
  return topics;
}

function sessionIdOfPayload(event: FeedEvent): string | null {
  switch (event.type) {
    case 'session.opened':
    case 'session.updated':
      return event.session.session_id;
    case 'session.closed':
    case 'session.removed':
    case 'session.warning':
      return event.session_id;
    case 'tool.called':
      return event.row.session_id;
    case 'page.visited':
    case 'screenshot.captured':
    case 'vault.access':
      return event.row.session_id;
    case 'blocklist.hit':
      return event.row.session_id;
    case 'attention.created':
    case 'attention.resolved':
    case 'vault.confirm.created':
    case 'vault.confirm.resolved':
      return event.request.session_id;
    default:
      return null;
  }
}

/**
 * Subscribes the hub to the bus. Every event with a WS payload schema is validated (internal keys
 * stripped) and published on its topics; `session.updated` is coalesced per session; auth logout
 * and revocation close the affected sockets with 4401. Returns an unsubscribe.
 */
export function wireFeed(deps: FeedDeps): () => void {
  const log = deps.logger.child({ module: 'ws.feed' });
  const pendingUpdates = new Map<string, FeedEvent>();
  const deliver = (event: FeedEvent): void => {
    for (const topic of topicsForEvent(event.type, sessionIdOfPayload(event))) {
      deps.target.publish(topic, event);
    }
  };
  const unsubscribeBus = deps.bus.subscribeAll((published) => {
    const name: string = published.name;
    const payload: unknown = published.payload;
    if (name === 'auth.logout' || name === 'auth.session_revoked') {
      const id = authSessionIdOf(payload);
      if (id !== null) deps.target.closeAuthSession(id);
      return;
    }
    const parsed = WsFeedEvent.safeParse(payload);
    if (!parsed.success) {
      log.trace('feed event skipped', { name });
      return;
    }
    const event = parsed.data;
    if (event.type === 'session.closed') {
      deps.onSessionClosed?.(event.session_id, event.reason === 'crash');
    }
    if (event.type === 'session.updated') {
      const id = event.session.session_id;
      const first = !pendingUpdates.has(id);
      pendingUpdates.set(id, event);
      if (first) {
        deps.schedule(() => {
          const latest = pendingUpdates.get(id);
          pendingUpdates.delete(id);
          if (latest !== undefined) deliver(latest);
        }, SESSION_UPDATE_COALESCE_MS);
      }
      return;
    }
    deliver(event);
  });
  const unsubscribeLogs = deps.logs?.subscribe((entry) => deps.target.publishLog(entry));
  return () => {
    unsubscribeBus();
    unsubscribeLogs?.();
  };
}

function authSessionIdOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('details' in payload)) return null;
  const details: unknown = payload.details;
  if (typeof details !== 'object' || details === null || !('auth_session_id' in details))
    return null;
  const id: unknown = details.auth_session_id;
  return typeof id === 'string' ? id : null;
}
