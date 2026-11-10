/** @module infra/browsers/page-dispatcher-options — the attribution dispatcher's hold length, its target-facts reader and its constructor options (spec 13 §3.4). */

import type { Page } from 'playwright';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { PageOwner, TargetFacts } from './page-attribution.ts';

/**
 * How long an undecided page waits for a pending `createTarget` response (spec 13 §3.4 rule 3);
 * also the deadline of one target-facts read. A page following a held opener waits at most one
 * more hold.
 */
export const ATTRIBUTION_HOLD_MS = 2_000;

/**
 * Reads a new page's target facts. Synchronous facts keep delivery in the `page` event's own turn;
 * a template host reads `Target.getTargetInfo` (PR T1a). A read that fails, or does not settle
 * within the facts deadline, leaves the page with no known target id or opener: it goes to the
 * fallback owner (parked on a template host).
 */
export type TargetFactsReader = (page: Page) => TargetFacts | Promise<TargetFacts>;

/** Constructor options of `HostPageDispatcher`. */
export interface HostPageDispatcherOptions {
  /** Owner of an unclaimed page without a known opener: the session (exclusive) or parked (template). */
  readonly fallback: PageOwner;
  /** Absent: every page gets a fresh id with no opener (an exclusive host needs neither). */
  readonly factsOf?: TargetFactsReader;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Hold length (default {@link ATTRIBUTION_HOLD_MS}). */
  readonly holdMs?: number;
  /** Deadline of one facts read (default {@link ATTRIBUTION_HOLD_MS}). */
  readonly factsTimeoutMs?: number;
  readonly tombstoneLimit?: number;
  /**
   * Called for every page committed while open (a session's or parked), before the session's
   * listeners, during the delivery drain: a template host keeps its parked-page bound and resolves
   * the windows it is waiting for here.
   */
  readonly onCommitted?: (page: Page, owner: PageOwner, facts: TargetFacts) => void;
  /**
   * Called instead of the listeners for a page attributed to a session that was already released
   * (a popup that arrived after `close_session`): a template host closes it (spec 13 §3.5).
   */
  readonly onReleased?: (page: Page, sessionId: string) => void;
}
