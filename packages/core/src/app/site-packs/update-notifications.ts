/** @module app/site-packs/update-notifications — the `site_pack.update_pending` producer rule (spec 13 §8.6): one thread `site-packs:updates` that opens while a followed pack has a pending version or a local file needs approval (warn when a local file changed since approval) and resolves when none is left. Fed by the registry's `site_pack.status` events. */

import { KIND_SEVERITY } from '@browserhive/contracts/notifications';
import type { DomainEvents, SitePackUpdatesFact } from '../events/catalog.ts';
import { clip, link, text } from '../notifications/message.ts';
import type { NotificationDraft, ThreadRevision } from '../notifications/producer-types.ts';

/** The one thread of pack updates. */
export const UPDATES_THREAD = 'site-packs:updates';
/** Where the notification opens. */
export const UPDATES_PATH = '/site-packs?pending=1';

const SUMMARY_MAX = 300;
const LABEL_MAX = 60;
const MAX_LINES = 12;

type Item = SitePackUpdatesFact['items'][number];

/** "linkedin.com v7 → v8 available", "local linkedin.com changed". */
function line(item: Item): string {
  if (item.local === 'changed') return `local ${item.pack_id} changed`;
  if (item.local === 'not_approved') return `local ${item.pack_id} not yet approved`;
  const from = item.from_version === null ? '' : `v${item.from_version} → `;
  return `${item.pack_id} ${from}v${item.to_version} available`;
}

/** `site_pack.status` with something waiting: opens the thread (once while it is open). */
export function updatesDraft(payload: DomainEvents['site_pack.status']): NotificationDraft | null {
  const updates = payload.updates;
  if (updates === undefined || updates.items.length === 0) return null;
  const items = updates.items;
  const warn = items.some((i) => i.local === 'changed');
  const count = items.length;
  return {
    type: 'system',
    kind: 'site_pack.update_pending',
    severity: warn ? 'warn' : KIND_SEVERITY['site_pack.update_pending'],
    state: 'open',
    thread: UPDATES_THREAD,
    title:
      count === 1
        ? 'A site pack update waits for review'
        : `${count} site pack updates wait for review`,
    body: clip(items.map(line).join('; '), SUMMARY_MAX),
    sessionId: null,
    target: UPDATES_PATH,
    sourceEventId: null,
    dedupKey: `sp-upd:${items
      .map((i) => `${i.pack_id}@${i.to_version}:${i.local ?? 'c'}:${i.sha256}`)
      .sort()
      .join(',')}`,
    once: { kinds: ['site_pack.update_pending'] },
    content: () => ({
      blocks: [
        {
          type: 'fields',
          items: items.slice(0, MAX_LINES).map((i) => ({
            label: clip(i.title, LABEL_MAX),
            value: [text(line(i))],
          })),
        },
      ],
      actions: [
        {
          kind: 'open',
          id: 'open-site-packs',
          label: 'Review updates',
          style: 'primary',
          path: UPDATES_PATH,
        },
      ],
      entities: {},
    }),
  };
}

/** `site_pack.status` with nothing waiting: the open thread resolves. */
export function updatesRevision(payload: DomainEvents['site_pack.status']): ThreadRevision | null {
  const updates = payload.updates;
  if (updates === undefined || updates.items.length > 0) return null;
  return {
    thread: UPDATES_THREAD,
    kinds: ['site_pack.update_pending'],
    dedupKey: `sp-upd-none:${updates.at}`,
    change: {
      state: 'resolved',
      summary: 'No site pack update waits for review.',
      fields: [{ label: 'Reviewed', value: [link('Site packs', '/site-packs')] }],
    },
  };
}
