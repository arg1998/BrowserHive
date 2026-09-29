/** @module routes/_auth/notifications_.reports_.$notificationId — `/notifications/reports/$notificationId`: one report drawn natively (spec 04 §12.11.2, D-45) */
import { createFileRoute } from '@tanstack/react-router';
import { ReportPage } from '@/features/notifications/reports/ReportPage.tsx';

/** One report. */
export const Route = createFileRoute('/_auth/notifications_/reports_/$notificationId')({
  component: ReportPage,
  staticData: {
    title: 'Report',
    crumb: () => 'Report',
  },
});
