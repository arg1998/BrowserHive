/** @module routes/_auth/websites — `/websites` navigation history (spec 04 §12.5) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { WEBSITES_DEFAULTS, websitesSearch } from '@/features/websites/search.ts';
import { WebsitesPage } from '@/features/websites/WebsitesPage.tsx';

/** Websites. */
export const Route = createFileRoute('/_auth/websites')({
  component: WebsitesPage,
  validateSearch: websitesSearch,
  search: { middlewares: [stripSearchParams(WEBSITES_DEFAULTS)] },
  staticData: {
    title: 'Websites',
    nav: { label: 'Websites', icon: 'websites', group: 'primary', order: 30, key: 'w' },
    palette: { keywords: ['navigation', 'pages', 'urls', 'domains', 'history'] },
  },
});
