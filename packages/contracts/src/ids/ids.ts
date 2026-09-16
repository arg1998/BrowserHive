/** @module contracts/ids/ids — branded id schemas, regexes and the slug grammar (D-23) */
import { z } from 'zod';

/**
 * Slug grammar.
 *
 * - Must start with a lowercase letter (not a digit / dash) so the resulting session id never
 *   begins with `-` and is always a syntactically clean filesystem entry name.
 * - 2–32 chars total (1+`{1,31}`).
 * - Lowercase ASCII alphanumerics and dashes only — no underscores, no Unicode.
 *
 * The resulting `<slug>-<nanoid8>` string must be filesystem-safe; the slug regex is the
 * load-bearing half, the id alphabet is the other.
 */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Alphabet of the random suffix of session and tab ids: `0-9a-z`. Lowercase only, no separators,
 * so the id segment is always a single safe filesystem token.
 */
export const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Default nanoid alphabet (`A-Za-z0-9_-`) used by ids that never touch the filesystem. */
export const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

/** Length of the random suffix after the slug in a session id. */
export const SESSION_ID_SUFFIX_LENGTH = 8;

/** Length of the random suffix in a tab id. */
export const TAB_ID_SUFFIX_LENGTH = 6;

/** Session id grammar: `<slug>-<nanoid8 over ID_ALPHABET>`; groups 1 and 2 are slug and suffix. */
export const SESSION_ID_RE = /^([a-z][a-z0-9-]{1,31})-([0-9a-z]{8})$/;

/** Tab id grammar: `t-<nanoid6 over ID_ALPHABET>`; stable for the life of the tab, never reused. */
export const TAB_ID_RE = /^t-[0-9a-z]{6}$/;

/** ULID body: 26 Crockford base32 characters (time-sortable). */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Event id grammar: `e-<ulid>` (D-23; time-sortable, so ids order like their events). */
export const EVENT_ID_RE = /^e-[0-9A-HJKMNP-TV-Z]{26}$/;

/** Operator request id grammar: `a-<nanoid12>` (one grammar for every request kind of the D-15 broker). */
export const OPERATOR_REQUEST_ID_RE = /^a-[A-Za-z0-9_-]{12}$/;

/** Principal id grammar: `p-<nanoid12>` (D-09 `principals.principal_id`). */
export const PRINCIPAL_ID_RE = /^p-[A-Za-z0-9_-]{12}$/;

/** Notification id grammar: `n-<nanoid12>` (D-16 `notifications.notification_id`). */
export const NOTIFICATION_ID_RE = /^n-[A-Za-z0-9_-]{12}$/;

/** Realtime connection id grammar: `c-<nanoid10>` (admin WebSocket connection ids). */
export const CONNECTION_ID_RE = /^c-[A-Za-z0-9_-]{10}$/;

/** MCP Streamable HTTP session id grammar: `m-<nanoid16>` (spec 02 `sessionIdGenerator`). */
export const MCP_SESSION_ID_RE = /^m-[A-Za-z0-9_-]{16}$/;

/** Branded session id (`<slug>-<nanoid8>`). Construct via `SessionId.parse` or the id generator. */
export const SessionId = z.string().regex(SESSION_ID_RE).brand<'SessionId'>();
/** Branded session id type. */
export type SessionId = z.infer<typeof SessionId>;

/** Branded tab id (`t-<nanoid6>`). */
export const TabId = z.string().regex(TAB_ID_RE).brand<'TabId'>();
/** Branded tab id type. */
export type TabId = z.infer<typeof TabId>;

/** Branded event id (`e-<ulid>`); links `tool_calls` ↔ `pages` ↔ `screenshots` and doubles as the tool span id. */
export const EventId = z.string().regex(EVENT_ID_RE).brand<'EventId'>();
/** Branded event id type. */
export type EventId = z.infer<typeof EventId>;

/** Branded operator request id (`a-<nanoid12>`); attention and vault-confirm requests share it. */
export const OperatorRequestId = z
  .string()
  .regex(OPERATOR_REQUEST_ID_RE)
  .brand<'OperatorRequestId'>();
/** Branded operator request id type. */
export type OperatorRequestId = z.infer<typeof OperatorRequestId>;

/** Branded principal id (`p-<nanoid12>`). */
export const PrincipalId = z.string().regex(PRINCIPAL_ID_RE).brand<'PrincipalId'>();
/** Branded principal id type. */
export type PrincipalId = z.infer<typeof PrincipalId>;

/** Branded notification id (`n-<nanoid12>`). */
export const NotificationId = z.string().regex(NOTIFICATION_ID_RE).brand<'NotificationId'>();
/** Branded notification id type. */
export type NotificationId = z.infer<typeof NotificationId>;

/** Branded realtime connection id (`c-<nanoid10>`). */
export const ConnectionId = z.string().regex(CONNECTION_ID_RE).brand<'ConnectionId'>();
/** Branded realtime connection id type. */
export type ConnectionId = z.infer<typeof ConnectionId>;

/** Branded MCP session id (`m-<nanoid16>`). */
export const McpSessionId = z.string().regex(MCP_SESSION_ID_RE).brand<'McpSessionId'>();
/** Branded MCP session id type. */
export type McpSessionId = z.infer<typeof McpSessionId>;

/** The two halves of a canonical session id. */
export interface SessionIdComponents {
  /** The caller-chosen slug (matches {@link SLUG_RE}). */
  readonly slug: string;
  /** The random 8-character suffix over {@link ID_ALPHABET}. */
  readonly suffix: string;
}

/**
 * Pure slug check against {@link SLUG_RE}. Throwing `INVALID_SLUG` is the caller's job (core).
 *
 * @returns `true` when `slug` is a valid session slug.
 */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Inverse of the session id builder. Returns the slug + suffix pair, or
 * `null` if `id` is not in canonical form (callers treat that as `SESSION_NOT_FOUND`, never log it).
 *
 * @returns The components or `null`; never throws.
 */
export function parseSessionId(id: string): SessionIdComponents | null {
  const match = SESSION_ID_RE.exec(id);
  const slug = match?.[1];
  const suffix = match?.[2];
  if (slug === undefined || suffix === undefined) return null;
  return { slug, suffix };
}
