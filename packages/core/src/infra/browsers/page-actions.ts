/** @module infra/browsers/page-actions — the `PageActions` port over Playwright: main-world evaluate, per-session humanize state, driver error classification. */

import type { Page } from 'playwright';
import type { Clock } from '../../ports/clock.ts';
import type {
  DriverErrorContext,
  HumanClickInput,
  HumanScrollInput,
  HumanTypeInput,
  PageActions,
  PointerActionInput,
} from '../../ports/page-actions.ts';
import { classifyDriverError } from './classify-error.ts';
import {
  type ActionPage,
  estimateTypingMs,
  humanClick,
  humanHover,
  humanScroll,
  humanType,
} from './humanize/actions.ts';
import { CursorTracker } from './humanize/cursor.ts';
import { type Rng, seededRng } from './humanize/rng.ts';

/** Dependencies of {@link createPlaywrightPageActions}. */
export interface PlaywrightPageActionsDeps {
  /** Injected so humanize pauses are abortable and fake clocks drive tests. */
  readonly clock?: Clock;
}

/** Patchright's `evaluate` signature: a fourth positional `isolatedContext` after the options bag. */
type DriverEvaluate = (
  expression: string,
  arg: undefined,
  options?: { exposeFunctions?: boolean },
  isolatedContext?: boolean,
) => Promise<unknown>;

interface SessionState {
  readonly rng: Rng;
  readonly tracker: CursorTracker;
}

/** The Playwright `Page` narrowed to what the humanize layer drives. Safe: it is a real `Page`. */
function asActionPage(page: Page): ActionPage {
  const widened: unknown = page;
  return widened as ActionPage;
}

/**
 * Builds the production {@link PageActions}. One seeded rng (`mulberry32(FNV-1a(sessionId))`) and
 * one cursor tracker per session, created lazily and dropped by `forgetSession`.
 */
export function createPlaywrightPageActions(deps: PlaywrightPageActionsDeps = {}): PageActions {
  const sessions = new Map<string, SessionState>();
  const sleep = deps.clock === undefined ? undefined : deps.clock.sleep.bind(deps.clock);
  const stateFor = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created = { rng: seededRng(sessionId), tracker: new CursorTracker() };
    sessions.set(sessionId, created);
    return created;
  };
  const shared = (sessionId: string, input: PointerActionInput) => {
    const state = stateFor(sessionId);
    return {
      page: asActionPage(input.page),
      tracker: state.tracker,
      rng: state.rng,
      timeout: input.timeout,
      selector: input.selector,
      native: input.native,
      ...(sleep !== undefined && { sleep }),
    };
  };

  return {
    evaluate(page, isolatedEvaluate, expression) {
      // Same method object, widened to the driver-specific signature; the cast is on the method,
      // not on a payload (Playwright's overloads cannot express the Patchright extension).
      const driver = page as unknown as { evaluate: DriverEvaluate };
      return isolatedEvaluate
        ? driver.evaluate(expression, undefined, undefined, false)
        : driver.evaluate(expression, undefined);
    },
    humanClick(sessionId, input: HumanClickInput) {
      return humanClick({
        ...shared(sessionId, input),
        ...(input.button !== undefined && { button: input.button }),
        ...(input.clickCount !== undefined && { clickCount: input.clickCount }),
        ...(input.modifiers !== undefined && { modifiers: input.modifiers }),
        ...(input.position !== undefined && { position: input.position }),
      });
    },
    humanHover(sessionId, input) {
      return humanHover(shared(sessionId, input));
    },
    humanType(sessionId, input: HumanTypeInput) {
      return humanType({
        ...shared(sessionId, input),
        text: input.text,
        focus: input.focus,
        ...(input.onProgress !== undefined && { onProgress: input.onProgress }),
      });
    },
    humanScroll(sessionId, input: HumanScrollInput) {
      return humanScroll({
        page: asActionPage(input.page),
        rng: stateFor(sessionId).rng,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        ...(sleep !== undefined && { sleep }),
      });
    },
    estimateTypingMs(text) {
      return estimateTypingMs(text);
    },
    observeExternalMove(sessionId, page, x, y) {
      stateFor(sessionId).tracker.observeExternalMove(page, x, y);
    },
    invalidateCursor(sessionId, page) {
      sessions.get(sessionId)?.tracker.invalidate(page);
    },
    forgetSession(sessionId) {
      sessions.delete(sessionId);
    },
    classifyError(err, context: DriverErrorContext) {
      return classifyDriverError(err, context);
    },
  };
}
