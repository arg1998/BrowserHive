/** @module infra/browsers/humanize/actions — the humanize policy layer: humanClick/humanHover/humanType/humanScroll with native fallbacks. */

/**
 * The modules underneath this one are pure geometry and cadence. This is where they meet a real
 * browser, and where the two rules that keep humanization from doing harm are enforced:
 *
 * **1. Never lose Playwright's actionability machinery.** `page.click(selector)` does far more than
 * click: it waits for the element to be attached, visible, stable, enabled, and not covered, retrying
 * as the page settles, and it resolves selectors across frames. Driving `mouse.move`/`down`/`up` at
 * raw coordinates throws all of that away. So the humanized path *runs the native waits first*
 * (`scrollIntoViewIfNeeded` → `boundingBox`) and only takes over for the final movement. If the
 * element cannot produce a box, the native call runs instead and produces its own — correct — error.
 *
 * **2. Never blow the tool's time budget.** Human cadence costs hundreds of milliseconds per action
 * and, for typing, potentially far more. A tool call that overruns its timeout surfaces as
 * `ELEMENT_NOT_ACTIONABLE` — a *misleading* error blaming the page for a delay we introduced. Every
 * entry point therefore estimates its cost against the caller's timeout and degrades or steps aside
 * before that can happen.
 *
 * `fill`/`drag_and_drop`/`select_option` stay native even under humanize: `fill` is a single value
 * assignment (no cadence to imitate, and a humanized one would be honest-but-slower for nothing),
 * `select_option` drives a native popup no pointer path reaches, and humanizing a drag would trade a
 * behavioural signal for outright broken drags.
 */

import { sleep as defaultSleep, type Sleep } from './clock.ts';
import {
  type BoundingBox,
  type CursorPage,
  type CursorTracker,
  clickBox,
  hoverBox,
  type MouseButton,
  moveTo,
  scrollBy,
} from './cursor.ts';
import type { Rng } from './rng.ts';
import {
  DEFAULT_TYPING_OPTIONS,
  performTyping,
  planTyping,
  type TypingKeyboard,
  type TypingOptions,
} from './typing.ts';

/** Longest run of text entered with full human cadence; the remainder is typed at native speed. */
export const MAX_HUMANIZED_CHARS = 400;

/**
 * Fraction of a tool's timeout that humanization may consume. The remainder is left for the page's
 * own work — navigation triggered by the action, validation, re-render — which still has to fit.
 */
export const BUDGET_FRACTION = 0.6;

/**
 * Rough upper bound on one humanized pointer movement. Used only to decide whether to attempt one —
 * the real cost comes from the path model, which caps itself at `PathOptions.maxDurationMs`.
 */
export const POINTER_ESTIMATE_MS = 1_200;

/** The `Locator` surface the policy layer needs. A structural subset of Playwright's. */
export interface ActionLocator {
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  boundingBox(options?: { timeout?: number }): Promise<BoundingBox | null>;
}

/** The `Page` surface the policy layer needs. A structural subset of Playwright's. */
export interface ActionPage extends CursorPage {
  locator(selector: string): ActionLocator;
  readonly keyboard: TypingKeyboard & {
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
}

/** Shared inputs to every humanized action. */
export interface ActionContext {
  readonly page: ActionPage;
  readonly tracker: CursorTracker;
  readonly rng: Rng;
  readonly sleep?: Sleep;
  /** The caller's timeout for this tool call, in ms. `0` means "no timeout" in Playwright. */
  readonly timeout: number;
}

/**
 * Resolve an element to a box using Playwright's own waits, or `null` when it has none.
 *
 * A `null` box is not an error here — it is the signal to hand the whole action back to the native
 * path, which will raise the accurate diagnosis (hidden, detached, zero-sized, covered) rather than
 * us guessing at one.
 */
async function resolveBox(
  page: ActionPage,
  selector: string,
  timeout: number,
): Promise<BoundingBox | null> {
  try {
    const locator = page.locator(selector);
    await locator.scrollIntoViewIfNeeded({ timeout });
    const box = await locator.boundingBox({ timeout });
    if (box === null || box.width <= 0 || box.height <= 0) return null;
    return box;
  } catch {
    // Any actionability failure: fall back so the native call reports it in the usual shape.
    return null;
  }
}

/** True when a movement of this estimated cost fits inside the caller's budget. */
export function withinBudget(estimateMs: number, timeout: number): boolean {
  // Playwright treats `0` as "no timeout"; there is nothing to overrun.
  return timeout === 0 || estimateMs <= timeout * BUDGET_FRACTION;
}

/** Inputs to {@link humanClick}. */
export interface HumanClickParams extends ActionContext {
  readonly selector: string;
  readonly button?: MouseButton;
  readonly clickCount?: number;
  readonly modifiers?: readonly string[];
  readonly position?: { readonly x: number; readonly y: number };
  /** The exact native call to run instead, if humanization cannot or should not proceed. */
  readonly native: () => Promise<void>;
}

/**
 * Humanized click: curved approach, off-centre landing point, held press.
 *
 * Modifiers are pressed around the humanized click rather than passed to a native call, so
 * `Control+click` keeps both the modifier semantics and the human path.
 */
export async function humanClick(params: HumanClickParams): Promise<void> {
  if (!withinBudget(POINTER_ESTIMATE_MS, params.timeout)) return params.native();
  const box = await resolveBox(params.page, params.selector, params.timeout);
  if (box === null) return params.native();

  const modifiers = params.modifiers ?? [];
  for (const modifier of modifiers) await params.page.keyboard.down(modifier);
  try {
    await clickBox(params.page, params.tracker, box, {
      rng: params.rng,
      ...(params.sleep !== undefined && { sleep: params.sleep }),
      ...(params.button !== undefined && { button: params.button }),
      ...(params.clickCount !== undefined && { clickCount: params.clickCount }),
      ...(params.position !== undefined && { position: params.position }),
    });
  } finally {
    // Release in reverse order, and always — a stuck modifier would poison every later keystroke.
    for (const modifier of [...modifiers].reverse()) await params.page.keyboard.up(modifier);
  }
}

/** Inputs to {@link humanHover}. */
export interface HumanHoverParams extends ActionContext {
  readonly selector: string;
  readonly native: () => Promise<void>;
}

/** Humanized hover: the same curved approach, without the press. */
export async function humanHover(params: HumanHoverParams): Promise<void> {
  if (!withinBudget(POINTER_ESTIMATE_MS, params.timeout)) return params.native();
  const box = await resolveBox(params.page, params.selector, params.timeout);
  if (box === null) return params.native();
  await hoverBox(params.page, params.tracker, box, {
    rng: params.rng,
    ...(params.sleep !== undefined && { sleep: params.sleep }),
  });
}

/** Inputs to {@link humanType}. */
export interface HumanTypeParams extends ActionContext {
  readonly selector: string;
  readonly text: string;
  /** Focus the field the way the caller's tool normally would (usually a click). */
  readonly focus: () => Promise<void>;
  /** Native fallback for the whole operation. */
  readonly native: () => Promise<void>;
  readonly typing?: Partial<TypingOptions>;
  /** Called as characters are entered, so a long type can report progress to the MCP client. */
  readonly onProgress?: (typed: number, total: number) => void;
}

/**
 * Humanized typing: focus the field, then enter text with log-normal inter-key cadence, word and
 * sentence pauses, and the occasional corrected typo.
 *
 * Two bounds keep this from becoming a liability on long input. Text beyond
 * {@link MAX_HUMANIZED_CHARS} is entered at native speed — the behavioural signal is carried by the
 * opening characters, and there is no defensible reason to spend two minutes on a paragraph. And the
 * plan is fitted to the remaining time budget, so a slow cadence compresses uniformly rather than
 * running out the tool's clock.
 */
export async function humanType(params: HumanTypeParams): Promise<void> {
  const options = { ...DEFAULT_TYPING_OPTIONS, ...params.typing };
  // Split on code points, not UTF-16 code units: a `slice` at the boundary can cut an astral
  // character (an emoji, most non-BMP scripts) into two lone surrogates, which are then typed as
  // separate keystrokes and land in the field as replacement characters.
  const codePoints = [...params.text];
  const humanized = codePoints.slice(0, MAX_HUMANIZED_CHARS).join('');
  const remainder = codePoints.slice(MAX_HUMANIZED_CHARS).join('');

  // A tiny budget cannot fit even a compressed cadence; do not pretend otherwise.
  const budget = params.timeout === 0 ? undefined : params.timeout * BUDGET_FRACTION;
  if (budget !== undefined && budget < options.intervalBounds.min * humanized.length * 0.25) {
    return params.native();
  }

  await params.focus();

  const wait = params.sleep ?? defaultSleep;
  const total = params.text.length;
  const plan = planTyping(humanized, params.rng, options, budget);
  await performTyping(params.page.keyboard, plan, wait, (completed, planLength) => {
    // Progress notifications keep a long type alive against the MCP client's response ceiling.
    // Reported against the caller's character count, since that is what they asked for; the plan is
    // longer than the text whenever it contains a typo correction.
    if (completed % 20 !== 0) return;
    params.onProgress?.(Math.round((completed / planLength) * humanized.length), total);
  });

  if (remainder.length > 0) await params.page.keyboard.type(remainder);
  params.onProgress?.(total, total);
}

/** Estimated wall-clock cost of humanizing `text`, for callers that must size a timeout up front. */
export function estimateTypingMs(text: string, overrides: Partial<TypingOptions> = {}): number {
  const options = { ...DEFAULT_TYPING_OPTIONS, ...overrides };
  const humanized = Math.min(text.length, MAX_HUMANIZED_CHARS);
  return Math.round(humanized * options.medianIntervalMs * 1.2);
}

/** Inputs to {@link humanScroll}. */
export interface HumanScrollParams {
  readonly page: ActionPage;
  readonly rng: Rng;
  readonly sleep?: Sleep;
  readonly deltaX: number;
  readonly deltaY: number;
}

/**
 * Humanized relative scroll, via real wheel events in several notches.
 *
 * Worth calling out because it fixes an existing tell rather than only softening one: the native
 * implementation calls `window.scrollBy()`, so the document moves while **no `wheel` event is ever
 * dispatched**. A page listening for `wheel` sees scrolling with no cause.
 */
export async function humanScroll(params: HumanScrollParams): Promise<void> {
  await scrollBy(params.page, params.deltaX, params.deltaY, {
    rng: params.rng,
    ...(params.sleep !== undefined && { sleep: params.sleep }),
  });
}

/** Re-exported so callers can drive a bare movement (e.g. resyncing after a takeover). */
export { moveTo };
