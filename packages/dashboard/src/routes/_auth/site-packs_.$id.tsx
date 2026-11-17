/** @module routes/_auth/site-packs_.$id — `/site-packs/$id`: one site pack (spec 13 §11.4, PR T3a) */
import { createFileRoute } from '@tanstack/react-router';
import { SitePackPage } from '@/features/site-packs/detail/SitePackPage.tsx';

/** One site pack. */
export const Route = createFileRoute('/_auth/site-packs_/$id')({
  component: SitePackPage,
  staticData: {
    title: 'Site pack',
    crumb: () => 'Site pack',
    requires: 'sitePacks',
  },
});
