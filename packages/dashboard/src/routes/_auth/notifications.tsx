/** @module routes/_auth/notifications — `/notifications` (spec 04 §12.11) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { NotificationsPage } from '@/features/notifications/NotificationsPage.tsx';
import { NOTIFICATIONS_DEFAULTS, notificationsSearch } from '@/features/notifications/search.ts';

/** Notifications. */
export const Route = createFileRoute('/_auth/notifications')({
  component: NotificationsPage,
  validateSearch: notificationsSearch,
  search: { middlewares: [stripSearchParams(NOTIFICATIONS_DEFAULTS)] },
  staticData: { title: 'Notifications', palette: { keywords: ['bell', 'alerts', 'preferences'] } },
});
