/** @module routes/_auth/notifications_.reports — `/notifications/reports`: reports in BrowserHive and their history (filters in the URL; spec 04 §12.11.2, D-45) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { ReportsPage } from '@/features/notifications/reports/ReportsPage.tsx';
import { REPORTS_DEFAULTS, reportsSearch } from '@/features/notifications/reports/search.ts';

/** Reports. */
export const Route = createFileRoute('/_auth/notifications_/reports')({
  component: ReportsPage,
  validateSearch: reportsSearch,
  search: { middlewares: [stripSearchParams(REPORTS_DEFAULTS)] },
  staticData: {
    title: 'Reports',
    palette: {
      keywords: ['digest', 'daily digest', 'weekly digest', 'anomaly', 'report', 'summary'],
    },
  },
});
