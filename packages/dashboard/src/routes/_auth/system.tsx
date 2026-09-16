/** @module routes/_auth/system — `/system` with Status, Agent tokens and Configuration sections (`?tab`) (spec 04 §12.10) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { SystemPage } from '@/features/system/SystemPage.tsx';
import { SYSTEM_DEFAULTS, systemSearch } from '@/features/system/search.ts';

/** System. */
export const Route = createFileRoute('/_auth/system')({
  component: SystemPage,
  validateSearch: systemSearch,
  search: { middlewares: [stripSearchParams(SYSTEM_DEFAULTS)] },
  staticData: {
    title: 'System',
    nav: { label: 'System', icon: 'system', group: 'primary', order: 90, key: 'y' },
    palette: {
      keywords: [
        'config',
        'retention',
        'migrations',
        'health',
        'degradations',
        'version',
        'tokens',
      ],
    },
  },
});
