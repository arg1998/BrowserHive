/** @module contracts/http/notifications — in-app notifications and operator preferences (spec 03 §4.8, D-16) */
import { z } from 'zod';
import { NotificationType } from '../enums/index.ts';
import { NotificationId, SessionId } from '../ids/index.ts';
import {
  Count,
  csv,
  EpochMs,
  listQuery,
  OkResponse,
  page,
  sortable,
  windowQuery,
} from './common.ts';

/**
 * One notification row. Read/dismiss state is server-side and survives reloads. Repeated
 * occurrences of the same thing (tool errors of one session) fold into one row: `count` grows,
 * `updated_at`, `title`, `body` and `source_event_id` follow the latest occurrence, and the change
 * is broadcast as `notification.updated`.
 */
export const Notification = z.object({
  notification_id: NotificationId,
  principal_id: z.string().nullable(),
  type: NotificationType,
  title: z.string(),
  body: z.string().nullable(),
  session_id: SessionId.nullable(),
  /** Slug part of `session_id` (for the row's meta line); `null` when there is no session. */
  session_slug: z.string().nullable(),
  target: z.string().nullable(),
  source_event_id: z.string().nullable(),
  created_at: EpochMs,
  /** Latest occurrence folded into the row; equals `created_at` when `count` is 1. */
  updated_at: EpochMs,
  /** Occurrences folded into the row (≥ 1). */
  count: z.number().int().min(1),
  read_at: EpochMs.nullable(),
  dismissed_at: EpochMs.nullable(),
});
/** One notification row. */
export type Notification = z.infer<typeof Notification>;

/** Path params for `/notifications/{notification_id}`. */
export const NotificationIdParams = z.strictObject({ notification_id: NotificationId });
/** Path params for `/notifications/{notification_id}`. */
export type NotificationIdParams = z.infer<typeof NotificationIdParams>;

/** `GET /notifications` query. */
export const NotificationsQuery = listQuery({
  /** `updated_at` (default) moves a growing group to the top; `since`/`until` apply to the sort column. */
  sort: sortable(['updated_at', 'created_at']).default('updated_at'),
  filters: {
    read: z.enum(['all', 'unread', 'read']).default('all'),
    type: csv(NotificationType),
    ...windowQuery,
  },
});
/** `GET /notifications` query. */
export type NotificationsQuery = z.infer<typeof NotificationsQuery>;

/** `GET /notifications` body: `Page<Notification>` plus the bell count. */
export const NotificationsPage = page(Notification).extend({ unread_count: Count });
/** `GET /notifications` body. */
export type NotificationsPage = z.infer<typeof NotificationsPage>;

/** `POST /notifications/{id}/read` and `DELETE /notifications/{id}` body. */
export const NotificationAckResponse = OkResponse;

/** `POST /notifications/read-all` and `/dismiss-all` body. */
export const NotificationsUpdatedResponse = z.object({ ok: z.literal(true), updated: Count });
/** `POST /notifications/read-all` and `/dismiss-all` body. */
export type NotificationsUpdatedResponse = z.infer<typeof NotificationsUpdatedResponse>;

/** Byte cap of the preferences document (spec 03 §4.8). */
export const PREFERENCES_MAX_BYTES = 64 * 1024;

/** One saved list view (filters + sort as URL search). */
export const SavedView = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  route: z.string().min(1).max(128),
  search: z.record(z.string(), z.unknown()),
});
/** One saved list view. */
export type SavedView = z.infer<typeof SavedView>;

/**
 * Operator preferences stored server-side (shared across devices). Known keys only; unknown keys
 * are rejected. Theme and per-device conveniences stay in `localStorage`.
 */
export const Preferences = z.strictObject({
  sidebar: z.enum(['expanded', 'collapsed']).optional(),
  default_page_size: z.number().int().min(10).max(500).optional(),
  saved_views: z.array(SavedView).max(100).optional(),
  notifications: z
    .strictObject({
      toasts: z.boolean().optional(),
      types: z.array(NotificationType).optional(),
    })
    .optional(),
  page_defaults: z.record(z.string().max(64), z.record(z.string().max(64), z.unknown())).optional(),
});
/** Operator preferences. */
export type Preferences = z.infer<typeof Preferences>;

/** `GET /me/preferences` body. */
export const PreferencesResponse = z.object({
  preferences: Preferences,
  updated_at: EpochMs.nullable(),
});
/** `GET /me/preferences` body. */
export type PreferencesResponse = z.infer<typeof PreferencesResponse>;

/** `PUT /me/preferences` body (whole document; ≤ 64 KiB). */
export const PutPreferencesRequest = z.strictObject({ preferences: Preferences });
/** `PUT /me/preferences` body. */
export type PutPreferencesRequest = z.infer<typeof PutPreferencesRequest>;

/** `PUT /me/preferences` 200 body. */
export const PutPreferencesResponse = z.object({ ok: z.literal(true), updated_at: EpochMs });
/** `PUT /me/preferences` 200 body. */
export type PutPreferencesResponse = z.infer<typeof PutPreferencesResponse>;
