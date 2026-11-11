/** @module routes/_auth/site-packs — `/site-packs`: an indented child of Templates; "not available yet" until site packs ship (spec 13 §11.4, §17 T3a) */
import { createFileRoute } from '@tanstack/react-router';
import { SitePacksPage } from '@/features/site-packs/SitePacksPage.tsx';

/** Site packs. */
export const Route = createFileRoute('/_auth/site-packs')({
  component: SitePacksPage,
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
    palette: { keywords: ['packs', 'sites', 'registry'] },
  },
});
