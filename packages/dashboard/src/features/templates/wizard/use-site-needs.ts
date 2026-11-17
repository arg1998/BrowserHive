/** @module features/templates/wizard/use-site-needs — the needs of the wizard's chosen sites (spec 13 §9.4, §11.1): for each site a pack covers, the pack's content from `GET /site-packs/{id}` (the same cache entry the chosen-site card reads), turned into `SiteNeeds` */
import type { SitePackView } from '@browserhive/contracts/http';
import { useQueries } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { packNote } from '@/features/site-packs/model.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { type SiteNeeds, siteNeedsOf } from './site-needs.ts';

/** Needs of the chosen sites, in their order; sites without a pack or a need are left out. */
export function useSiteNeeds(
  sites: readonly string[],
  packs: readonly SitePackView[],
): readonly SiteNeeds[] {
  const api = useApi();
  const covered = sites.flatMap((site) => {
    const note = packNote(packs, site);
    return note === null ? [] : [{ site, pack: note.pack }];
  });
  const details = useQueries({
    queries: covered.map(({ pack }) => ({
      queryKey: keys.sitePacks.detail(pack.pack_id),
      queryFn: () => api.getSitePack({ params: { pack_id: pack.pack_id } }),
      staleTime: 30_000,
      retry: (count: number, error: unknown) => toAppError(error).status !== 404 && count < 2,
    })),
  });
  return covered.flatMap(({ site, pack }, i) => {
    const content = details[i]?.data?.pack;
    const needs = content == null ? null : siteNeedsOf(site, pack.title, content);
    return needs === null ? [] : [needs];
  });
}
