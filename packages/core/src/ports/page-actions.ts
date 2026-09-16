/** @module ports/page-actions — driver-side page helpers the tool layer needs but may not import from `infra/browsers`: main-world evaluate, humanize decorators, driver error classification. */

import type { Page } from 'playwright';
import type { AppError } from '../kernel/errors/app-error.ts';

/** Shared inputs of every humanized pointer action. */
export interface PointerActionInput {
  readonly page: Page;
  /** The caller's timeout for this tool call in ms (`0` = no timeout). */
  readonly timeout: number;
  readonly selector: string;
  /** The exact native Playwright call to run when humanization cannot or should not proceed. */
  readonly native: () => Promise<void>;
}

/** `click` decorator input. */
export interface HumanClickInput extends PointerActionInput {
  readonly button?: 'left' | 'right' | 'middle';
  readonly clickCount?: number;
  readonly modifiers?: readonly string[];
  readonly position?: { readonly x: number; readonly y: number };
}

/** `type_text` decorator input. */
export interface HumanTypeInput extends PointerActionInput {
  readonly text: string;
  /** Focuses the field the way a person would (a humanized click). */
  readonly focus: () => Promise<void>;
  /** Progress callback (typed, total) for long texts. */
  readonly onProgress?: (typed: number, total: number) => void;
}

/** `scroll(mode='by')` decorator input. */
export interface HumanScrollInput {
  readonly page: Page;
  readonly deltaX: number;
  readonly deltaY: number;
}

/** What the caller knows about a failed driver call (fills the detail slots the prose lacks). */
export interface DriverErrorContext {
  readonly selector?: string;
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly tabId?: string;
  readonly sessionId?: string;
  /** Human label of the awaited condition (`selector '#x' to be visible`, `load state`). */
  readonly what?: string;
}

/**
 * The page-interaction seam between `interface/mcp/tools` and `infra/browsers`. Composition
 * implements it with `evaluateMainWorld`, the humanize layer (one seeded rng and cursor tracker per
 * session) and `classifyDriverError`; tests implement it with pass-through fakes.
 */
export interface PageActions {
  /**
   * Evaluates a JavaScript **expression string** in the page's main world regardless of driver
   * (Patchright isolates `evaluate` by default; `isolatedEvaluate` comes from the session handle).
   */
  evaluate(page: Page, isolatedEvaluate: boolean, expression: string): Promise<unknown>;
  /** Humanized click (curved path, dwell); falls back to `native` when it cannot proceed. */
  humanClick(sessionId: string, input: HumanClickInput): Promise<void>;
  /** Humanized hover. */
  humanHover(sessionId: string, input: PointerActionInput): Promise<void>;
  /** Humanized typing (log-normal cadence, corrected typos). */
  humanType(sessionId: string, input: HumanTypeInput): Promise<void>;
  /** Humanized relative scroll via real wheel notches. */
  humanScroll(sessionId: string, input: HumanScrollInput): Promise<void>;
  /** Estimated wall-clock cost of humanizing `text`, so a caller can size its timeout. */
  estimateTypingMs(text: string): number;
  /**
   * Records a pointer position the agent did not produce (an operator's takeover input), so the
   * next humanized move starts from where the cursor really is.
   */
  observeExternalMove(sessionId: string, page: Page, x: number, y: number): void;
  /** Drops the cursor mirror of `page` (after a viewport resize). */
  invalidateCursor(sessionId: string, page: Page): void;
  /** Releases per-session humanize state once the session is gone. */
  forgetSession(sessionId: string): void;
  /** Maps a Playwright error onto a registry `AppError`, or `null` when the prose matches no row. */
  classifyError(err: unknown, context: DriverErrorContext): AppError | null;
}
