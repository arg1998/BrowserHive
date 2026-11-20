/** @module app/notifications/producer-types — the shapes producer rules yield (spec 03 §9.1): a notification draft or a lifecycle revision of a thread. */

import type {
  NotificationKind,
  NotificationSeverity,
  NotificationState,
  NotificationType,
} from '@browserhive/contracts/enums';
import type { LifecycleChange, MessageContent } from './message.ts';

/** What a producer rule yields before persistence assigns id, principal and timestamps. */
export interface NotificationDraft {
  readonly type: NotificationType;
  /** Contract kind (D-32); category follows from it. */
  readonly kind: NotificationKind;
  readonly severity: NotificationSeverity;
  /** State of the first revision (`open` for requests and groups, `final` for one-shot facts). */
  readonly state: NotificationState;
  /** Conversation key (`attention:<request_id>`, `session:<id>`, `tool-errors:<session|none>`). */
  readonly thread: string;
  readonly title: string;
  readonly body: string | null;
  readonly sessionId: string | null;
  /** Dashboard route to open on click. */
  readonly target: string | null;
  /** Id of the originating event/request (for de-duplication across reconnect replays). */
  readonly sourceEventId: string | null;
  /** Idempotency key (`att:<id>`, `closed:<id>:<at>`, `err:<event>`, `vault:<id>`). */
  readonly dedupKey: string;
  /** When set, occurrences fold into one open row of the group instead of new rows (spec 03 §9). */
  readonly group?: NotificationGroup;
  /**
   * At most one open row per thread among these kinds: while one is open, the draft creates nothing
   * (a template's sign-out per identity provider, spec 13 §8.6).
   */
  readonly once?: { readonly kinds: readonly NotificationKind[] };
  /** Blocks, actions and entities of the message for a row holding `count` occurrences (1 unless grouped). */
  readonly content: (count: number) => MessageContent;
  /**
   * A screenshot this notification may carry (D-36): `live` captures the session's page now
   * (attention, vault confirm: before the fill starts), `last` uses its last stored screenshot (a
   * crash). Taken only when a channel wants it (spec 03 §9.5).
   */
  readonly image?: ImageRequest;
}

/** What screenshot a draft asks for. */
export interface ImageRequest {
  readonly sessionId: string;
  readonly source: 'live' | 'last';
  /** Alt text of the image block. */
  readonly alt: string;
  /** Dashboard page that shows the context (used where a channel cannot carry images). */
  readonly path: string;
}

/** How a draft folds into an existing row. */
export interface NotificationGroup {
  /** Group identity within one inbox (`tool-errors:<session_id>`). */
  readonly key: string;
  /** Title of the row once it holds `count` occurrences. */
  readonly title: (count: number) => string;
}

/** A lifecycle revision of the notification that owns `thread` (spec 03 §9.1). */
export interface ThreadRevision {
  /** The thread, or with {@link ThreadRevision.prefix} the prefix of the threads to revise. */
  readonly thread: string;
  /**
   * `thread` is a prefix: the newest row of each open thread under it is revised, except the
   * threads listed (a template's sign-out threads once their site or the template is gone, spec 13
   * §8.6). Needs `kinds`.
   */
  readonly prefix?: { readonly except: readonly string[] };
  /** Revise the newest row of these kinds only (a thread several kinds share, spec 13 §8.6). */
  readonly kinds?: readonly NotificationKind[];
  readonly change: LifecycleChange;
  /** Idempotency key of the revision (`att-res:<id>`). */
  readonly dedupKey: string;
}
