/** @module features/site-packs/live — keeps pack queries current over the `site-packs` topic (spec 13 §11.3): a changed pack patches the cached lists in place and refreshes its page and the templates using it; a new pending version or local file refreshes the lists, the badge and that pack; a status change (a reload, an update check) puts the new registry status into the cached lists at once and refreshes them */
import type { WsFeedEvent } from '@browserhive/contracts/ws';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { keys } from '@/lib/api/keys.ts';
import { patchCachedStatus, patchCachedView } from './api.ts';

/** The topic. */
export const SITE_PACKS_TOPIC = 'site-packs';

/** Apply one `site-packs` event to the cache (tested). */
export function applySitePackEvent(qc: QueryClient, event: WsFeedEvent): void {
  switch (event.type) {
    case 'site_pack.changed':
      patchCachedView(qc, event.view);
      void qc.invalidateQueries({ queryKey: keys.sitePacks.lists() });
      void qc.invalidateQueries({ queryKey: keys.sitePacks.detail(event.view.pack_id) });
      void qc.invalidateQueries({ queryKey: ['site-packs', 'diff', event.view.pack_id] });
      void qc.invalidateQueries({ queryKey: keys.sitePacks.changes() });
      if (event.view.used_by.length > 0)
        void qc.invalidateQueries({ queryKey: keys.templates.details() });
      return;
    case 'site_pack.pending':
      void qc.invalidateQueries({ queryKey: keys.sitePacks.lists() });
      void qc.invalidateQueries({ queryKey: keys.sitePacks.detail(event.pack_id) });
      return;
    case 'site_pack.status':
      patchCachedStatus(qc, event.status);
      void qc.invalidateQueries({ queryKey: keys.sitePacks.lists() });
      return;
    default:
      return;
  }
}

/** Subscribe the page to pack changes; `enabled: false` (site packs off) subscribes to nothing. */
export function useSitePacksLive(enabled = true): void {
  const qc = useQueryClient();
  useTopic(enabled ? SITE_PACKS_TOPIC : null, (event) => applySitePackEvent(qc, event));
}
