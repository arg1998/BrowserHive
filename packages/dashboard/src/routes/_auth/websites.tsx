/** @module routes/_auth/websites — `/websites` navigation history, a detail page of Overview (no sidebar entry; spec 04 §12.5) */
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
    parent: '/overview',
    palette: {
      keywords: ['navigation', 'pages', 'urls', 'domains', 'history', 'overview'],
      icon: 'websites',
    },
  },
});
