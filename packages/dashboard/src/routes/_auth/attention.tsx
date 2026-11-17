/** @module routes/_auth/attention — `/attention` (spec 04 §12.4) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { AttentionPage } from '@/features/attention/AttentionPage.tsx';
import { ATTENTION_DEFAULTS, attentionSearch } from '@/features/attention/search.ts';

/** Attentions. */
export const Route = createFileRoute('/_auth/attention')({
  component: AttentionPage,
  validateSearch: attentionSearch,
  search: { middlewares: [stripSearchParams(ATTENTION_DEFAULTS)] },
  staticData: {
    title: 'Attentions',
    nav: { label: 'Attentions', icon: 'attention', group: 'primary', order: 50, key: 'a' },
    palette: { keywords: ['queue', 'takeover', 'blocked', 'request_attention'] },
  },
});
