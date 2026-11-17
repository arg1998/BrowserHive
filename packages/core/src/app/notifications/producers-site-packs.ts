/** @module app/notifications/producers-site-packs — `site_pack.write_confirm` (spec 13 §8.6): one coalesced thread per template site showing how many writes wait for approval, with Approve / Deny on the newest request for guards of kind `write` only, resolved once none is open. */

import {
  KIND_SEVERITY,
  type NotificationAction,
  type NotificationEntities,
} from '@browserhive/contracts/notifications';
import type { SiteConfirmEvent } from '../../ports/site-guards.ts';
import { clip, code, link, type MessageContent, text, time } from './message.ts';
import type { NotificationDraft, ThreadRevision } from './producer-types.ts';

const TITLE_MAX = 120;
const KINDS = ['site_pack.write_confirm'] as const;

/** The thread of a template site's write confirmations. */
export function siteConfirmThread(templateId: string, site: string): string {
  return `site-confirm:${templateId}:${site}`;
}

function title(e: SiteConfirmEvent): string {
  const writes = e.open === 1 ? '1 write needs' : `${e.open} writes need`;
  return clip(`${e.template_name}: ${writes} approval on ${e.site_title}`, TITLE_MAX);
}

/** `site_pack.confirm` opened: the thread opens, or its open row grows with the new count. */
export function writeConfirmDraft(e: SiteConfirmEvent): NotificationDraft | null {
  if (e.phase !== 'opened') return null;
  const thread = siteConfirmThread(e.template_id, e.site);
  const queue = '/attention';
  const guard = `${e.guard.pack_id}#${e.guard.id}`;
  const actions: NotificationAction[] = [];
  // Only plain writes can be approved from a notification; logout, account, credential and
  // destructive guards are decided on /attention, where the full request is shown (spec 13 §9.3).
  if (e.guard.kind === 'write') {
    actions.push(
      {
        kind: 'act',
        id: 'approve',
        label: 'Approve',
        style: 'primary',
        command: {
          op: 'attention.resolve',
          args: { request_id: e.request_id, decision: 'resolve' },
        },
        confirm: null,
        fallback: { label: 'Review in BrowserHive', path: queue },
      },
      {
        kind: 'act',
        id: 'deny',
        label: 'Deny',
        style: 'danger',
        command: {
          op: 'attention.resolve',
          args: { request_id: e.request_id, decision: 'reject' },
        },
        confirm: 'Deny this write? The request is aborted.',
        fallback: { label: 'Review in BrowserHive', path: queue },
      },
    );
  }
  actions.push({
    kind: 'open',
    id: 'review',
    label: 'Review',
    style: e.guard.kind === 'write' ? 'default' : 'primary',
    path: queue,
  });
  const entities: NotificationEntities = {
    session_id: e.session_id,
    request_id: e.request_id,
    template_id: e.template_id,
    template_name: clip(e.template_name, 64),
    domain: e.site,
    ...(e.tool !== null && { tool: e.tool }),
  };
  const content = (): MessageContent => ({
    blocks: [
      {
        type: 'fields',
        items: [
          { label: 'Template', value: [link(e.template_name, `/templates/${e.template_id}`)] },
          { label: 'Site', value: [code(e.site)] },
          ...(e.method === null ? [] : [{ label: 'Method', value: [code(e.method)] }]),
          { label: 'URL', value: [code(e.url)] },
          { label: 'Guard', value: [code(guard), text(` (${e.guard.kind})`)] },
          ...(e.tool === null ? [] : [{ label: 'Tool', value: [code(e.tool)] }]),
          { label: 'Waiting', value: [text(String(e.open))] },
          { label: 'Since', value: [time(e.at)] },
        ],
      },
    ],
    actions,
    entities,
  });
  const method = e.method === null ? '' : `${e.method} `;
  return {
    type: 'attention',
    kind: 'site_pack.write_confirm',
    severity: KIND_SEVERITY['site_pack.write_confirm'],
    state: 'open',
    thread,
    title: title(e),
    body: `${method}${e.url} waits for approval (guard ${guard}, ${e.guard.kind}).`,
    sessionId: e.session_id,
    target: queue,
    sourceEventId: e.request_id,
    dedupKey: `spc:${e.request_id}`,
    group: { key: thread, title: () => title(e) },
    content,
  };
}

/** `site_pack.confirm` settled with none left open: the thread resolves. */
export function writeConfirmRevision(e: SiteConfirmEvent): ThreadRevision | null {
  if (e.phase !== 'settled' || e.open > 0) return null;
  return {
    thread: siteConfirmThread(e.template_id, e.site),
    kinds: KINDS,
    dedupKey: `spc-res:${e.request_id}`,
    change: {
      state: 'resolved',
      summary: 'No write on this site waits for approval any more.',
      fields: [{ label: 'Last decided', value: [time(e.at)] }],
    },
  };
}
