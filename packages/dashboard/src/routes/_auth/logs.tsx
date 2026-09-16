/** @module routes/_auth/logs — `/logs` live log console (spec 04 §12.9) */
import { createFileRoute } from '@tanstack/react-router';
import { LogsPage } from '@/features/logs/LogsPage.tsx';
import { logsSearch } from '@/features/logs/search.ts';

/** Logs. */
export const Route = createFileRoute('/_auth/logs')({
  component: LogsPage,
  validateSearch: logsSearch,
  staticData: {
    title: 'Logs',
    nav: { label: 'Logs', icon: 'logs', group: 'primary', order: 80, key: 'l' },
    palette: { keywords: ['log', 'tail', 'trace', 'debug', 'level'] },
  },
});
