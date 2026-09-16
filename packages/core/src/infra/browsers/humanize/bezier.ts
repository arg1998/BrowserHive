/** @module infra/browsers/humanize/bezier — self-contained cubic Bézier geometry behind humanized pointer paths. */

/**
 * The reference humanizers (`ghost-cursor`, `ghost-cursor-playwright`) pull in `bezier-js` for four
 * operations: evaluate a point, evaluate the derivative, measure arc length, and sample a lookup
 * table of evenly-spaced-in-`t` points. All four are a handful of lines of closed-form algebra, so
 * they live here instead of as a dependency — no runtime package, no version coupling, and the
 * numerics are auditable in one screen.
 *
 * Everything in this module is pure. No randomness, no clock, no I/O.
 */

/** A 2-D point in CSS pixels, in the page's viewport coordinate space. */
export interface Vector {
  readonly x: number;
  readonly y: number;
}

/** The four control points of a cubic Bézier: `p0` and `p3` are the endpoints. */
export interface CubicBezier {
  readonly p0: Vector;
  readonly p1: Vector;
  readonly p2: Vector;
  readonly p3: Vector;
}

/**
 * Evaluate the curve at `t ∈ [0, 1]`:
 *
 * `B(t) = (1−t)³·p0 + 3(1−t)²t·p1 + 3(1−t)t²·p2 + t³·p3`
 */
export function bezierPoint(curve: CubicBezier, t: number): Vector {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * curve.p0.x + b * curve.p1.x + c * curve.p2.x + d * curve.p3.x,
    y: a * curve.p0.y + b * curve.p1.y + c * curve.p2.y + d * curve.p3.y,
  };
}

/**
 * Evaluate the first derivative at `t` — the velocity vector of a point travelling the curve at
 * uniform `t`-rate:
 *
 * `B'(t) = 3(1−t)²·(p1−p0) + 6(1−t)t·(p2−p1) + 3t²·(p3−p2)`
 *
 * Its magnitude is the local speed, which is what turns a geometric path into a *timed* one.
 */
export function bezierDerivative(curve: CubicBezier, t: number): Vector {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  return {
    x:
      a * (curve.p1.x - curve.p0.x) + b * (curve.p2.x - curve.p1.x) + c * (curve.p3.x - curve.p2.x),
    y:
      a * (curve.p1.y - curve.p0.y) + b * (curve.p2.y - curve.p1.y) + c * (curve.p3.y - curve.p2.y),
  };
}

/** Euclidean magnitude of a vector. */
export function magnitude(v: Vector): number {
  return Math.hypot(v.x, v.y);
}

/** Euclidean distance between two points. */
export function distance(a: Vector, b: Vector): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Default sample count for {@link bezierLength}. Even, as Simpson's rule requires. */
const ARC_LENGTH_SAMPLES = 24;

/**
 * Arc length of the curve, `∫₀¹ |B'(t)| dt`, by composite Simpson's rule over
 * {@link ARC_LENGTH_SAMPLES} intervals.
 *
 * Simpson's rule is exact for cubics and converges fast on the (non-polynomial) speed integrand, so
 * two dozen samples land well inside a pixel on any path a pointer actually travels — far more
 * accuracy than a path-length-driven step count can consume.
 */
export function bezierLength(curve: CubicBezier, samples: number = ARC_LENGTH_SAMPLES): number {
  // Simpson's rule needs an even interval count.
  const n = samples % 2 === 0 ? samples : samples + 1;
  const h = 1 / n;
  let total = magnitude(bezierDerivative(curve, 0)) + magnitude(bezierDerivative(curve, 1));
  for (let i = 1; i < n; i++) {
    const weight = i % 2 === 0 ? 2 : 4;
    total += weight * magnitude(bezierDerivative(curve, i * h));
  }
  return (total * h) / 3;
}

/**
 * Sample `steps + 1` points evenly spaced in the curve's **parameter** `t` (not in arc length),
 * inclusive of both endpoints. Uneven arc spacing is the point: a cubic naturally bunches samples
 * where it curves, which is also where a real hand slows down.
 */
export function bezierLut(curve: CubicBezier, steps: number): Vector[] {
  const count = Math.max(1, Math.floor(steps));
  const points: Vector[] = [];
  for (let i = 0; i <= count; i++) points.push(bezierPoint(curve, i / count));
  return points;
}

/**
 * The unit vector perpendicular to `a → b` (rotated a quarter-turn counter-clockwise). Returns the
 * zero vector for coincident points, which callers treat as "no perpendicular offset".
 */
export function perpendicular(a: Vector, b: Vector): Vector {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  return { x: -dy / length, y: dx / length };
}
