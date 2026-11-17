/** @module routes/_auth/site-packs — `/site-packs`: an indented child of Templates (spec 13 §11.4, PR T3a); tab, source and Updates available filters and search in the URL */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { SitePacksPage } from '@/features/site-packs/SitePacksPage.tsx';
import { SITE_PACKS_DEFAULTS, sitePacksSearch } from '@/features/site-packs/search.ts';

/** Site packs. */
export const Route = createFileRoute('/_auth/site-packs')({
  component: SitePacksPage,
  validateSearch: sitePacksSearch,
  search: { middlewares: [stripSearchParams(SITE_PACKS_DEFAULTS)] },
  staticData: {
    title: 'Site packs',
    nav: {
      label: 'Site packs',
      icon: 'sitePacks',
      group: 'primary',
      order: 26,
      parent: '/templates',
    },
    requires: 'sitePacks',
    palette: { keywords: ['packs', 'sites', 'registry', 'updates', 'guards'] },
  },
});
