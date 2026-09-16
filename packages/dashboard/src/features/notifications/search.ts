/** @module features/notifications/search — `/notifications` search params: read (all|unread|read), type csv, range (24h|7d|30d|all, default 7d), page, ps (spec 04 §12.11) */
import { NotificationType } from '@browserhive/contracts/enums';
import { z } from 'zod';
import { csvParam, pageParam, pageSizeParam, TABLE_SEARCH_DEFAULTS } from '@/lib/search/table.ts';

/** The notification window vocabulary (Today / 7 days / 30 days / All). */
export const NOTIFICATION_RANGES = ['24h', '7d', '30d', 'all'] as const;

/** Search schema. */
export const notificationsSearch = z.object({
  read: z.enum(['all', 'unread', 'read']).catch('all').default('all'),
  type: csvParam(NotificationType),
  range: z.enum(NOTIFICATION_RANGES).catch('7d').default('7d'),
  page: pageParam,
  ps: pageSizeParam,
});
/** Parsed search. */
export type NotificationsSearch = z.infer<typeof notificationsSearch>;
/** Defaults omitted from the URL. */
export const NOTIFICATIONS_DEFAULTS = {
  ...TABLE_SEARCH_DEFAULTS,
  read: 'all',
  range: '7d',
} as const;
