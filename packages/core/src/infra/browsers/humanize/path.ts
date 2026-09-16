/** @module infra/browsers/humanize/path — humanized pointer-path generation: Bézier geometry plus minimum-jerk cadence. */

/**
 * A synthetic click teleports — one `mouse.move` to the element's dead centre, then press. Three
 * things give that away to a behavioural scorer, and this module fixes all three:
 *
 *   1. **Trajectory.** Real motion is curved, not linear. A cubic Bézier with randomly-offset
 *      perpendicular anchors produces a gently, differently-curved arc every time.
 *   2. **Cadence.** Real motion has a *bell-shaped velocity profile* — accelerate, coast, decelerate
 *      onto the target. The reference OSS humanizers emit the right number of points with **no delay
 *      between them**, which fixes the shape and leaves the velocity profile as synthetic as before.
 *      We time the points with a minimum-jerk profile (see {@link minimumJerkPosition}) whose total
 *      duration comes from Fitts's law, so both the path and the speed along it are plausible.
 *   3. **Termination.** A long reach in a real hand overshoots and corrects (ballistic phase, then a
 *      corrective sub-movement). Past {@link DEFAULT_OPTIONS.overshootThreshold} we generate exactly
 *      that: an arc to a point near the target, then a short second arc onto it.
 *
 * The geometry constants follow `ghost-cursor` / `ghost-cursor-playwright` (MIT), whose distribution
 * is the de-facto reference; see `humanize/NOTICE.md`. The timing model is ours — the reference
 * implementation stamps synthetic timestamps onto CDP events, which Playwright's `page.mouse` has no
 * parameter for, so the model had to become real wall-clock sleeps.
 *
 * **Honest ceiling:** a canned Bézier distribution is itself classifiable, and vendors are known to
 * model this exact family of paths. This raises the floor from "trivially synthetic" to "needs a real
 * classifier"; it does not make motion indistinguishable from a human's.
 *
 * Everything here is pure: it takes an {@link Rng} and returns data. Nothing touches a browser.
 */

import {
  bezierLength,
  bezierLut,
  type CubicBezier,
  distance,
  perpendicular,
  type Vector,
} from './bezier.ts';
import { clamp, logNormal, type Rng, uniform } from './rng.ts';

/** One timed waypoint: move the pointer to `(x, y)` after waiting `delayMs`. */
export interface PathStep {
  readonly x: number;
  readonly y: number;
  /** Milliseconds to wait *before* emitting this point. `0` for the first step. */
  readonly delayMs: number;
}

/** Tunables of the path model. Production never overrides them (no per-call tuning is exposed). */
export interface PathOptions {
  /** Distance (px) past which the pointer overshoots and corrects, as a real hand does. */
  readonly overshootThreshold: number;
  /** Radius (px) of the disc the overshoot lands in, centred on the true target. */
  readonly overshootRadius: number;
  /** Bounds (px) on how far each Bézier anchor is pushed off the straight line. */
  readonly spread: { readonly min: number; readonly max: number };
  /** Fitts's-law intercept (ms) — the fixed cost of any movement. */
  readonly fittsIntercept: number;
  /** Fitts's-law slope (ms per bit of index-of-difficulty). */
  readonly fittsSlope: number;
  /** Effective target width (px) in the Fitts term. Larger ⇒ movements are treated as easier. */
  readonly targetWidth: number;
  /** Inclusive bounds on the number of emitted waypoints. Each one is a real IPC round-trip. */
  readonly steps: { readonly min: number; readonly max: number };
  /** Per-step multiplicative timing jitter, as the sigma of a log-normal with mu = 0. */
  readonly timingJitter: number;
  /** Hard ceiling (ms) on one movement, so a pathological geometry cannot stall a tool call. */
  readonly maxDurationMs: number;
}

/**
 * Defaults. The geometry values (`overshoot*`, `spread`) are `ghost-cursor`'s; the Fitts constants
 * are mid-range published values for mouse pointing (intercept ~100 ms, slope ~120 ms/bit), which put
 * a typical few-hundred-pixel reach at roughly 400–600 ms — about what a person takes.
 */
export const DEFAULT_OPTIONS: PathOptions = {
  overshootThreshold: 500,
  overshootRadius: 120,
  spread: { min: 2, max: 200 },
  fittsIntercept: 100,
  fittsSlope: 120,
  targetWidth: 100,
  steps: { min: 10, max: 60 },
  timingJitter: 0.12,
  maxDurationMs: 2_000,
};

/**
 * Fitts's index of difficulty, `2·log₂(distance / width + 1)` — the reference implementation's
 * formulation. Grows logarithmically, so a movement ten times longer costs only a few more bits.
 */
export function fittsDifficulty(dist: number, width: number): number {
  return 2 * Math.log2(dist / width + 1);
}

/**
 * Minimum-jerk normalized position, `10τ³ − 15τ⁴ + 6τ⁵`.
 *
 * The classic model of human reaching: velocity is `30τ²(1−τ)²`, a symmetric bell that starts and
 * ends at exactly zero. Mapping *arc position* through this profile is what converts an evenly
 * parameterised curve into a realistically-paced one.
 */
export function minimumJerkPosition(tau: number): number {
  const t = clamp(tau, 0, 1);
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
}

/**
 * Invert {@link minimumJerkPosition} by bisection: given a normalized arc position, find the
 * normalized *time* at which the profile reaches it. Monotonic on `[0, 1]`, so 40 halvings pin it to
 * ~1e-12 — far below the millisecond resolution the answer is used at.
 */
export function minimumJerkTime(position: number): number {
  const target = clamp(position, 0, 1);
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (minimumJerkPosition(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Build a curved Bézier from `start` to `end` by pushing two anchors off the straight line, each in a
 * random direction along the perpendicular and by a random amount. The spread scales with the
 * distance (a short hop should not arc like a screen-crossing sweep) but is clamped to the
 * reference's `[2, 200]` px so neither degenerates.
 */
export function curveBetween(
  start: Vector,
  end: Vector,
  rng: Rng,
  options: PathOptions = DEFAULT_OPTIONS,
): CubicBezier {
  const normal = perpendicular(start, end);
  const dist = distance(start, end);
  const maxSpread = clamp(dist / 2, options.spread.min, options.spread.max);

  const anchor = (fraction: number): Vector => {
    // Random signed offset along the perpendicular; the two anchors are drawn independently, so the
    // curve can be a simple bow or a gentle S.
    const offset = uniform(rng, -maxSpread, maxSpread);
    return {
      x: start.x + (end.x - start.x) * fraction + normal.x * offset,
      y: start.y + (end.y - start.y) * fraction + normal.y * offset,
    };
  };

  return { p0: start, p1: anchor(0.3), p2: anchor(0.7), p3: end };
}

/**
 * Pick a point uniformly inside a disc of `radius` around `centre` — the overshoot landing spot.
 * Uses `sqrt(u)` on the radius so the samples are area-uniform rather than clustered at the centre.
 */
export function pointNear(centre: Vector, radius: number, rng: Rng): Vector {
  const angle = uniform(rng, 0, 2 * Math.PI);
  const r = radius * Math.sqrt(rng.next());
  return { x: centre.x + Math.cos(angle) * r, y: centre.y + Math.sin(angle) * r };
}

/**
 * Number of waypoints for a curve of the given arc length — the reference's
 * `ceil((log₂(ID + 1) + rand·25) · 3)`, clamped to {@link PathOptions.steps}. The clamp matters:
 * every waypoint is an IPC round-trip, so an unbounded count turns a click into a visible stall.
 */
export function stepCountFor(arcLength: number, rng: Rng, options: PathOptions): number {
  const difficulty = fittsDifficulty(arcLength, options.targetWidth);
  const raw = Math.ceil((Math.log2(difficulty + 1) + rng.next() * 25) * 3);
  return clamp(raw, options.steps.min, options.steps.max);
}

/**
 * Total duration (ms) for a movement of `arcLength`, from Fitts's law plus a log-normal multiplier,
 * capped at {@link PathOptions.maxDurationMs}. The multiplier is what makes two identical reaches
 * take visibly different times, as a person's do.
 */
export function durationFor(arcLength: number, rng: Rng, options: PathOptions): number {
  const base =
    options.fittsIntercept + options.fittsSlope * fittsDifficulty(arcLength, options.targetWidth);
  const jitter = logNormal(rng, 0, options.timingJitter);
  return clamp(base * jitter, 1, options.maxDurationMs);
}

/**
 * Time one curve: sample it, measure the cumulative chord length to each sample, map that arc
 * fraction through the inverted minimum-jerk profile to get each sample's normalized *time*, and
 * difference those to get per-step delays.
 *
 * The result accelerates out of `start` and decelerates onto `end`, with sub-millisecond delays
 * rounded away (a 0 ms sleep is a yield, which is the honest thing to do — the transport cannot
 * resolve finer).
 */
function timeCurve(curve: CubicBezier, rng: Rng, options: PathOptions): PathStep[] {
  const arcLength = bezierLength(curve);
  const steps = stepCountFor(arcLength, rng, options);
  const points = bezierLut(curve, steps);

  // Cumulative chord length per sample — a close-enough stand-in for true arc length at this
  // sampling density, and monotonic by construction.
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous === undefined || current === undefined) continue;
    cumulative.push((cumulative[i - 1] ?? 0) + distance(previous, current));
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  const duration = durationFor(arcLength, rng, options);

  const stepJitter = (): number => logNormal(rng, 0, options.timingJitter);
  const result: PathStep[] = [];
  let previousTime = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === undefined) continue;
    const fraction = total === 0 ? (i === 0 ? 0 : 1) : (cumulative[i] ?? 0) / total;
    const time = minimumJerkTime(fraction) * duration;
    // Per-step jitter roughens the profile so consecutive intervals are not suspiciously smooth.
    const delay = i === 0 ? 0 : Math.max(0, Math.round((time - previousTime) * stepJitter()));
    previousTime = time;
    result.push({ x: point.x, y: point.y, delayMs: delay });
  }
  return result;
}

/**
 * Build the full timed path from `start` to `end`.
 *
 * Short reaches are a single arc. Past {@link PathOptions.overshootThreshold} the path becomes
 * ballistic-plus-corrective: one arc to a point drawn from a disc around the target, then a second,
 * tightly-curved arc onto the target itself — the two-phase structure of real reaching.
 *
 * The first step always carries `delayMs: 0`; callers move to it immediately and sleep the declared
 * delay before every subsequent point.
 */
export function humanPath(
  start: Vector,
  end: Vector,
  rng: Rng,
  overrides: Partial<PathOptions> = {},
): PathStep[] {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const dist = distance(start, end);

  if (dist <= options.overshootThreshold) {
    return timeCurve(curveBetween(start, end, rng, options), rng, options);
  }

  const landing = pointNear(end, options.overshootRadius, rng);
  const ballistic = timeCurve(curveBetween(start, landing, rng, options), rng, options);
  // The correction is a short, tight movement: clamp the spread down so it reads as a settle rather
  // than a second sweep.
  const correctionOptions: PathOptions = {
    ...options,
    spread: { min: options.spread.min, max: Math.min(options.spread.max, 20) },
  };
  const correction = timeCurve(
    curveBetween(landing, end, rng, correctionOptions),
    rng,
    correctionOptions,
  );

  // Drop the correction's duplicate first point (it is the ballistic phase's last), but keep a short
  // pause there — the hand momentarily settles before correcting.
  const [, ...rest] = correction;
  const settle = Math.round(uniform(rng, 20, 60));
  const first = rest[0];
  if (first !== undefined) rest[0] = { ...first, delayMs: first.delayMs + settle };
  return [...ballistic, ...rest];
}

/**
 * Pick a click point inside an element's box: uniformly within the middle portion, never the exact
 * centre (dead-centre clicks are a classic automation tell) and never within `inset` of an edge
 * (where a click can miss a rounded or padded target).
 */
export function pointInsideBox(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rng: Rng,
  inset = 0.15,
): Vector {
  const fraction = clamp(inset, 0, 0.45);
  const left = box.x + box.width * fraction;
  const right = box.x + box.width * (1 - fraction);
  const top = box.y + box.height * fraction;
  const bottom = box.y + box.height * (1 - fraction);
  return {
    x: right > left ? uniform(rng, left, right) : box.x + box.width / 2,
    y: bottom > top ? uniform(rng, top, bottom) : box.y + box.height / 2,
  };
}
