/** @module infra/browsers/humanize/cursor — per-page pointer mirror and the driver that walks a humanized path. */

/**
 * ## Why the position must be tracked at all
 *
 * A Bézier path needs a *start* point, and Playwright will not tell us where the pointer is —
 * `page.mouse` keeps its last position internally and exposes no reader. So we mirror it: every
 * successful `mouse.move` records where we left the pointer, and the next path begins there. That
 * mirror is what makes consecutive actions read as one continuous hand rather than a series of
 * teleports from nowhere.
 *
 * ## Why per-page and not per-session
 *
 * Playwright's mouse state is per-`Page`: moving the pointer in tab A does not move tab B's. Tracking
 * one position per session would generate a path starting where the *other* tab's pointer was — a
 * movement the driver never actually performs, so the emitted events would contradict the geometry we
 * think we drew. A `WeakMap` keyed by the `Page` object also means a closed tab's entry is collected
 * for free.
 *
 * ## Staleness
 *
 * Two things move the real pointer behind our back, and both must invalidate the mirror or the next
 * path will start from a lie:
 *   - an **operator takeover** through the live view, which dispatches its own CDP `Input.*` events;
 *   - a **viewport resize**, which can clamp the pointer inside the new bounds.
 * The takeover case is recoverable *exactly* — the operator's dispatched coordinate is the new
 * position — so it re-seeds rather than invalidating.
 */

import type { Vector } from './bezier.ts';
import { sleep as defaultSleep, type Sleep } from './clock.ts';
import { humanPath, type PathOptions, pointInsideBox } from './path.ts';
import { clamp, type Rng, uniform, uniformInt } from './rng.ts';

/** A rectangle in viewport coordinates, as returned by Playwright's `locator.boundingBox()`. */
export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Viewport dimensions in CSS pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Mouse button names accepted by the cursor driver. */
export type MouseButton = 'left' | 'right' | 'middle';

/** The minimal mouse surface the driver needs. A structural subset of Playwright's `Mouse`. */
export interface CursorMouse {
  move(x: number, y: number, options?: { steps?: number }): Promise<void>;
  down(options?: { button?: MouseButton; clickCount?: number }): Promise<void>;
  up(options?: { button?: MouseButton; clickCount?: number }): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

/** The minimal page surface the driver needs. A structural subset of Playwright's `Page`. */
export interface CursorPage {
  readonly mouse: CursorMouse;
  viewportSize(): Size | null;
}

/** Fallback viewport when a page reports none (headful windows can return `null`). */
const FALLBACK_VIEWPORT: Size = { width: 1280, height: 720 };

/**
 * Per-page mirror of the pointer position. Owned by the session (that is the natural lifetime, and
 * it puts the takeover hook within reach of the live-view manager).
 */
export class CursorTracker {
  private readonly positions = new WeakMap<object, Vector>();

  /**
   * Where the pointer is on this page, seeding a plausible starting point on first use.
   *
   * The seed is a random spot near the top or left edge rather than `{0, 0}`: a pointer that begins
   * every session at the exact viewport origin is a constant, and constants are what correlate
   * sessions to each other.
   */
  get(page: object, viewport: Size, rng: Rng): Vector {
    const existing = this.positions.get(page);
    if (existing !== undefined) return existing;
    const fromTop = rng.next() < 0.5;
    const seeded: Vector = fromTop
      ? { x: uniform(rng, 0, viewport.width), y: uniform(rng, 0, 40) }
      : { x: uniform(rng, 0, 40), y: uniform(rng, 0, viewport.height) };
    this.positions.set(page, seeded);
    return seeded;
  }

  /** Record the pointer position after a move we performed. */
  set(page: object, position: Vector): void {
    this.positions.set(page, position);
  }

  /**
   * An operator moved the real pointer through the live-view takeover. Their dispatched coordinate is
   * the truth, so adopt it — no path needs to be discarded.
   */
  observeExternalMove(page: object, x: number, y: number): void {
    this.positions.set(page, { x, y });
  }

  /** The position is no longer knowable (viewport resize). The next move re-seeds. */
  invalidate(page: object): void {
    this.positions.delete(page);
  }
}

/** Tunables for one humanized pointer action. */
export interface CursorOptions {
  readonly rng: Rng;
  readonly sleep?: Sleep;
  /** Overrides for the path geometry / cadence model. */
  readonly path?: Partial<PathOptions>;
  /** Bounds (ms) on how long a click's press is held. */
  readonly pressDwellMs?: { readonly min: number; readonly max: number };
  /** Bounds (ms) on the gap between clicks of a multi-click. */
  readonly interClickMs?: { readonly min: number; readonly max: number };
}

/** Click dwell 45–120 ms (spec 02 §7). */
export const DEFAULT_PRESS_DWELL = { min: 45, max: 120 } as const;
/** Inter-click gap 60–110 ms (spec 02 §7). */
export const DEFAULT_INTER_CLICK = { min: 60, max: 110 } as const;

/**
 * Walk the pointer from its current position to `target` along a humanized path, sleeping each step's
 * delay. Records the position after **every** successful move, so a failure mid-path still leaves the
 * mirror accurate rather than claiming the pointer reached the target.
 *
 * The target is clamped into the viewport: `mouse.move` outside it is silently dropped by Chromium,
 * which would desync the mirror from reality.
 */
export async function moveTo(
  page: CursorPage,
  tracker: CursorTracker,
  target: Vector,
  options: CursorOptions,
): Promise<void> {
  const viewport = page.viewportSize() ?? FALLBACK_VIEWPORT;
  const wait = options.sleep ?? defaultSleep;
  const destination: Vector = {
    x: clamp(target.x, 0, viewport.width - 1),
    y: clamp(target.y, 0, viewport.height - 1),
  };
  const start = tracker.get(page, viewport, options.rng);

  for (const step of humanPath(start, destination, options.rng, options.path)) {
    if (step.delayMs > 0) await wait(step.delayMs);
    const x = clamp(step.x, 0, viewport.width - 1);
    const y = clamp(step.y, 0, viewport.height - 1);
    await page.mouse.move(x, y);
    tracker.set(page, { x, y });
  }
}

/** Options for {@link clickBox} beyond the shared cursor tunables. */
export interface ClickOptions extends CursorOptions {
  readonly button?: MouseButton;
  readonly clickCount?: number;
  /** Exact point inside the box to hit. When omitted, a point is sampled inside it. */
  readonly position?: { readonly x: number; readonly y: number };
}

/**
 * Move onto an element's box and press it.
 *
 * The landing point is sampled *inside* the box rather than at its centre — a pointer that lands on
 * the exact geometric centre of every element it touches is one of the crudest automation tells there
 * is. A caller-supplied `position` (the `click` tool's own option) is honoured verbatim instead.
 */
export async function clickBox(
  page: CursorPage,
  tracker: CursorTracker,
  box: BoundingBox,
  options: ClickOptions,
): Promise<void> {
  const wait = options.sleep ?? defaultSleep;
  const target =
    options.position === undefined
      ? pointInsideBox(box, options.rng)
      : { x: box.x + options.position.x, y: box.y + options.position.y };

  await moveTo(page, tracker, target, options);

  const dwell = options.pressDwellMs ?? DEFAULT_PRESS_DWELL;
  const gap = options.interClickMs ?? DEFAULT_INTER_CLICK;
  const button = options.button ?? 'left';
  const count = Math.max(1, options.clickCount ?? 1);

  for (let i = 1; i <= count; i++) {
    if (i > 1) await wait(uniformInt(options.rng, gap.min, gap.max));
    await page.mouse.down({ button, clickCount: i });
    // A real press is held for a moment; down-then-instantly-up is a machine.
    await wait(uniformInt(options.rng, dwell.min, dwell.max));
    await page.mouse.up({ button, clickCount: i });
  }
}

/** Move onto an element's box without pressing. */
export async function hoverBox(
  page: CursorPage,
  tracker: CursorTracker,
  box: BoundingBox,
  options: CursorOptions,
): Promise<void> {
  await moveTo(page, tracker, pointInsideBox(box, options.rng), options);
}

/** Tunables for humanized wheel scrolling. */
export interface ScrollOptions {
  readonly rng: Rng;
  readonly sleep?: Sleep;
  /** Inclusive bounds on how many wheel notches the delta is split across. */
  readonly chunks?: { readonly min: number; readonly max: number };
  /** Inclusive bounds (ms) on the pause between notches. */
  readonly pauseMs?: { readonly min: number; readonly max: number };
}

/** Scroll notches 3–7 (spec 02 §7). */
export const DEFAULT_SCROLL_CHUNKS = { min: 3, max: 7 } as const;
/** Pause between notches 40–90 ms (spec 02 §7). */
export const DEFAULT_SCROLL_PAUSE = { min: 40, max: 90 } as const;

/**
 * Scroll by a delta using real wheel events, split into several notches with pauses.
 *
 * Wheel events rather than `window.scrollBy()`, which fires **no wheel events at all** — a page that
 * listens for `wheel` sees the document scroll with nothing having caused it. Splitting the delta
 * also matches how a physical wheel or trackpad actually delivers scroll: in bursts, not one jump.
 */
export async function scrollBy(
  page: CursorPage,
  deltaX: number,
  deltaY: number,
  options: ScrollOptions,
): Promise<void> {
  const wait = options.sleep ?? defaultSleep;
  const bounds = options.chunks ?? DEFAULT_SCROLL_CHUNKS;
  const pause = options.pauseMs ?? DEFAULT_SCROLL_PAUSE;
  const chunks = uniformInt(options.rng, bounds.min, bounds.max);

  let sentX = 0;
  let sentY = 0;
  for (let i = 1; i <= chunks; i++) {
    // Compute each notch from the cumulative target so rounding never loses or gains pixels.
    const targetX = Math.round((deltaX * i) / chunks);
    const targetY = Math.round((deltaY * i) / chunks);
    const stepX = targetX - sentX;
    const stepY = targetY - sentY;
    sentX = targetX;
    sentY = targetY;
    if (stepX === 0 && stepY === 0) continue;
    if (i > 1) await wait(uniformInt(options.rng, pause.min, pause.max));
    await page.mouse.wheel(stepX, stepY);
  }
}
