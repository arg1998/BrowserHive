/** @module routes/_auth/blocklist — `/blocklist` (spec 04 §12.6) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { BlocklistPage } from '@/features/blocklist/BlocklistPage.tsx';
import { BLOCKLIST_DEFAULTS, blocklistSearch } from '@/features/blocklist/search.ts';

/** Blocklist. */
export const Route = createFileRoute('/_auth/blocklist')({
  component: BlocklistPage,
  validateSearch: blocklistSearch,
  search: { middlewares: [stripSearchParams(BLOCKLIST_DEFAULTS)] },
  staticData: {
    title: 'Blocklist',
    nav: { label: 'Blocklist', icon: 'blocklist', group: 'primary', order: 40, key: 'b' },
    palette: { keywords: ['blocked', 'patterns', 'refused', 'urls'] },
  },
});
