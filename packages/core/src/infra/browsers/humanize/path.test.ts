/** @module infra/browsers/humanize/path.test — Bézier geometry, minimum-jerk cadence, humanPath and pointInsideBox. */

import { describe, expect, it } from 'bun:test';
import {
  bezierDerivative,
  bezierLength,
  bezierLut,
  bezierPoint,
  type CubicBezier,
  distance,
  perpendicular,
} from './bezier.ts';
import {
  curveBetween,
  DEFAULT_OPTIONS,
  durationFor,
  fittsDifficulty,
  humanPath,
  minimumJerkPosition,
  minimumJerkTime,
  pointInsideBox,
  stepCountFor,
} from './path.ts';
import { seededRng } from './rng.ts';

const STRAIGHT: CubicBezier = {
  p0: { x: 0, y: 0 },
  p1: { x: 10, y: 0 },
  p2: { x: 20, y: 0 },
  p3: { x: 30, y: 0 },
};

describe('path constants (spec 02 §7)', () => {
  it('pins the default values', () => {
    expect(DEFAULT_OPTIONS).toEqual({
      overshootThreshold: 500,
      overshootRadius: 120,
      spread: { min: 2, max: 200 },
      fittsIntercept: 100,
      fittsSlope: 120,
      targetWidth: 100,
      steps: { min: 10, max: 60 },
      timingJitter: 0.12,
      maxDurationMs: 2_000,
    });
  });
});

describe('cubic Bézier geometry', () => {
  it('interpolates the endpoints exactly', () => {
    expect(bezierPoint(STRAIGHT, 0)).toEqual({ x: 0, y: 0 });
    expect(bezierPoint(STRAIGHT, 1)).toEqual({ x: 30, y: 0 });
  });

  it('measures the arc length of a straight curve as its chord', () => {
    expect(bezierLength(STRAIGHT)).toBeCloseTo(30, 6);
  });

  it('measures a curved arc as longer than its chord', () => {
    const bowed: CubicBezier = {
      p0: { x: 0, y: 0 },
      p1: { x: 10, y: 40 },
      p2: { x: 20, y: 40 },
      p3: { x: 30, y: 0 },
    };
    expect(bezierLength(bowed)).toBeGreaterThan(distance(bowed.p0, bowed.p3));
  });

  it("derivative magnitude matches a finite-difference estimate (it is the curve's speed)", () => {
    const bowed: CubicBezier = {
      p0: { x: 0, y: 0 },
      p1: { x: 30, y: 90 },
      p2: { x: 70, y: -20 },
      p3: { x: 100, y: 50 },
    };
    const h = 1e-6;
    for (const t of [0.1, 0.5, 0.9]) {
      const analytic = bezierDerivative(bowed, t);
      const a = bezierPoint(bowed, t - h);
      const b = bezierPoint(bowed, t + h);
      expect(analytic.x).toBeCloseTo((b.x - a.x) / (2 * h), 3);
      expect(analytic.y).toBeCloseTo((b.y - a.y) / (2 * h), 3);
    }
  });

  it('samples steps + 1 points inclusive of both ends', () => {
    const lut = bezierLut(STRAIGHT, 8);
    expect(lut).toHaveLength(9);
    expect(lut[0]).toEqual({ x: 0, y: 0 });
    expect(lut[8]).toEqual({ x: 30, y: 0 });
  });

  it('returns a zero perpendicular for coincident points instead of NaN', () => {
    expect(perpendicular({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 0, y: 0 });
  });
});

describe('minimum-jerk profile', () => {
  it('runs from 0 to 1 and is monotonically increasing', () => {
    expect(minimumJerkPosition(0)).toBe(0);
    expect(minimumJerkPosition(1)).toBe(1);
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const value = minimumJerkPosition(i / 100);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('is symmetric about the midpoint — the bell-shaped velocity profile', () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(minimumJerkPosition(t) + minimumJerkPosition(1 - t)).toBeCloseTo(1, 9);
    }
  });

  it('inverts to within a rounding error', () => {
    for (const t of [0.05, 0.3, 0.5, 0.77, 0.99]) {
      expect(minimumJerkTime(minimumJerkPosition(t))).toBeCloseTo(t, 6);
    }
  });
});

describe('fittsDifficulty', () => {
  it('grows with distance but only logarithmically', () => {
    const near = fittsDifficulty(100, 100);
    const far = fittsDifficulty(1_000, 100);
    expect(far).toBeGreaterThan(near);
    // Ten times the distance must not cost ten times the difficulty.
    expect(far).toBeLessThan(near * 4);
  });
});

describe('stepCountFor / durationFor', () => {
  it('clamps the step count so a click never becomes a visible stall', () => {
    const rng = seededRng('steps');
    for (let i = 0; i < 200; i++) {
      const steps = stepCountFor(2_000, rng, DEFAULT_OPTIONS);
      expect(steps).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.steps.min);
      expect(steps).toBeLessThanOrEqual(DEFAULT_OPTIONS.steps.max);
    }
  });

  it('caps the duration and keeps it positive', () => {
    const rng = seededRng('duration');
    for (let i = 0; i < 200; i++) {
      const ms = durationFor(50_000, rng, DEFAULT_OPTIONS);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(DEFAULT_OPTIONS.maxDurationMs);
    }
  });

  it('varies duration between identical movements', () => {
    // Two identical reaches taking exactly the same time is itself the tell.
    const rng = seededRng('vary');
    const runs = new Set(Array.from({ length: 20 }, () => durationFor(400, rng, DEFAULT_OPTIONS)));
    expect(runs.size).toBeGreaterThan(10);
  });
});

describe('curveBetween', () => {
  it('keeps the endpoints and bends off the straight line', () => {
    const rng = seededRng('curve');
    const start = { x: 0, y: 0 };
    const end = { x: 400, y: 300 };
    const curve = curveBetween(start, end, rng);
    expect(curve.p0).toEqual(start);
    expect(curve.p3).toEqual(end);
    expect(bezierLength(curve)).toBeGreaterThan(distance(start, end) * 0.99);
  });

  it('degenerates safely when start and end coincide', () => {
    const curve = curveBetween({ x: 5, y: 5 }, { x: 5, y: 5 }, seededRng('same'));
    for (const point of bezierLut(curve, 4)) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});

describe('humanPath', () => {
  const rng = () => seededRng('path');

  it('starts at the origin with no delay and ends exactly on the target', () => {
    const steps = humanPath({ x: 10, y: 10 }, { x: 300, y: 200 }, rng());
    expect(steps[0]).toMatchObject({ x: 10, y: 10, delayMs: 0 });
    const last = steps[steps.length - 1];
    expect(last?.x).toBeCloseTo(300, 6);
    expect(last?.y).toBeCloseTo(200, 6);
  });

  it('emits non-negative integer delays', () => {
    for (const step of humanPath({ x: 0, y: 0 }, { x: 500, y: 400 }, rng())) {
      expect(Number.isInteger(step.delayMs)).toBe(true);
      expect(step.delayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('accelerates then decelerates rather than moving at a constant rate', () => {
    // A flat velocity profile is as synthetic as a straight line; the shape is the signal.
    // Kept under `overshootThreshold` so this measures ONE arc — an overshooting path is two
    // concatenated profiles and its thirds do not line up with a single acceleration curve.
    const steps = humanPath({ x: 0, y: 0 }, { x: 400, y: 0 }, rng(), { timingJitter: 0 });
    const gaps = steps.slice(1).map((s) => s.delayMs);
    const third = Math.floor(gaps.length / 3);
    const head = gaps.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const middle = gaps.slice(third, 2 * third).reduce((a, b) => a + b, 0) / third;
    const tail = gaps.slice(2 * third).reduce((a, b) => a + b, 0) / (gaps.length - 2 * third);
    // Fast in the middle means the *gaps* there are smallest.
    expect(middle).toBeLessThan(head);
    expect(middle).toBeLessThan(tail);
  });

  it('overshoots and corrects on a long reach, but not on a short one', () => {
    const short = humanPath({ x: 0, y: 0 }, { x: 100, y: 0 }, rng());
    const long = humanPath({ x: 0, y: 0 }, { x: 1_400, y: 0 }, rng());
    // The corrective phase makes the long path travel past the target and come back.
    expect(Math.max(...long.map((s) => s.x))).toBeGreaterThan(1_400);
    expect(Math.max(...short.map((s) => s.x))).toBeLessThanOrEqual(100.0001);
    expect(long.length).toBeGreaterThan(short.length);
  });

  it('is reproducible from a seed and different across seeds', () => {
    expect(humanPath({ x: 0, y: 0 }, { x: 200, y: 200 }, seededRng('a'))).toEqual(
      humanPath({ x: 0, y: 0 }, { x: 200, y: 200 }, seededRng('a')),
    );
    expect(humanPath({ x: 0, y: 0 }, { x: 200, y: 200 }, seededRng('a'))).not.toEqual(
      humanPath({ x: 0, y: 0 }, { x: 200, y: 200 }, seededRng('b')),
    );
  });

  it('produces finite coordinates for a zero-length move', () => {
    for (const step of humanPath({ x: 50, y: 50 }, { x: 50, y: 50 }, rng())) {
      expect(Number.isFinite(step.x)).toBe(true);
      expect(Number.isFinite(step.y)).toBe(true);
    }
  });
});

describe('pointInsideBox', () => {
  const box = { x: 100, y: 50, width: 200, height: 40 };

  it('lands inside the box but never on the exact centre', () => {
    // Dead-centre clicks on every element are one of the crudest automation tells there is.
    const rng = seededRng('box');
    let centreHits = 0;
    for (let i = 0; i < 300; i++) {
      const point = pointInsideBox(box, rng);
      expect(point.x).toBeGreaterThan(box.x);
      expect(point.x).toBeLessThan(box.x + box.width);
      expect(point.y).toBeGreaterThan(box.y);
      expect(point.y).toBeLessThan(box.y + box.height);
      if (point.x === box.x + box.width / 2 && point.y === box.y + box.height / 2) centreHits++;
    }
    expect(centreHits).toBe(0);
  });

  it('falls back to the centre for a degenerate box rather than producing NaN', () => {
    const point = pointInsideBox({ x: 10, y: 10, width: 0, height: 0 }, seededRng('degenerate'));
    expect(point).toEqual({ x: 10, y: 10 });
  });
});
