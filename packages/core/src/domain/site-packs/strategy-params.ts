/** @module domain/site-packs/strategy-params — the typed, clamped parameters of each strategy (spec 13 §9.4): what every runtime hook reads (`strategyOf`), the parameter checks `refinePack` runs (`strategyParamIssues`), and the ramp and window helpers. The bounds come from the strategy table (`strategy-specs.ts`). */

import type { SitePackV1, StrategyId } from '@browserhive/contracts/site-packs';
import { STRATEGY_SPECS, type StrategyParamSpec } from './strategy-specs.ts';

/** A WebRTC policy (`webrtc-policy`). */
export type WebRtcPolicy = 'default_public_interface_only' | 'disable_non_proxied_udp';

/** The typed, clamped parameters of each strategy. */
export interface StrategyParams {
  readonly 'pace-writes': Readonly<Record<string, never>>;
  readonly 'launch-spacing': { readonly minGapS: number; readonly jitterPct: number };
  readonly 'ramp-up': { readonly days: number; readonly startFraction: number };
  readonly 'serialize-site': { readonly maxParallel: number };
  readonly 'human-dwell': { readonly minMs: number; readonly maxMs: number };
  readonly 'humanize-input': Readonly<Record<string, never>>;
  readonly 'entry-warmup': {
    readonly path: string;
    readonly dwellMs: number;
    readonly referrer: 'none' | 'same-site' | 'search';
  };
  readonly 'keep-alive': { readonly intervalH: number };
  readonly 'active-hours': {
    readonly startHour: number;
    readonly endHour: number;
    readonly weekdaysOnly: boolean;
  };
  readonly 'device-bound-session': Readonly<Record<string, never>>;
  readonly 'stealth-profile': {
    readonly minLevel: 'standard' | 'max';
    readonly fingerprint: 'required' | 'forbidden' | 'any';
    readonly humanize: boolean;
  };
  readonly 'single-focus': Readonly<Record<string, never>>;
  readonly 'webrtc-policy': { readonly policy: WebRtcPolicy };
}

type RawParams = Readonly<Record<string, number | boolean | string>>;

/** A parameter problem `refinePack` reports (the version is refused). */
export interface StrategyParamIssue {
  readonly param: string | null;
  readonly message: string;
}

/**
 * Checks a strategy's raw parameters (spec 13 §9.4): unknown names, wrong types, enum values,
 * paths, and the cross-parameter rules (`active-hours` needs a window of at least 1 h). Numbers out
 * of bounds are not issues: they are clamped when read.
 */
export function strategyParamIssues(id: StrategyId, raw: RawParams): StrategyParamIssue[] {
  const spec = STRATEGY_SPECS[id];
  const issues: StrategyParamIssue[] = [];
  const known = new Map(spec.params.map((p) => [p.name, p]));
  for (const [name, value] of Object.entries(raw)) {
    const param = known.get(name);
    if (param === undefined) {
      issues.push({ param: name, message: `'${id}' has no parameter '${name}'` });
      continue;
    }
    const problem = typeProblem(param, value);
    if (problem !== null) issues.push({ param: name, message: problem });
  }
  if (id === 'active-hours' && issues.length === 0) {
    const start = clampInt(raw['start_hour'], 8, 0, 23);
    const end = clampInt(raw['end_hour'], 22, 0, 23);
    if (start === end) {
      issues.push({ param: 'end_hour', message: 'the window must be at least 1 h (start ≠ end)' });
    }
  }
  return issues;
}

function typeProblem(param: StrategyParamSpec, value: number | boolean | string): string | null {
  switch (param.type) {
    case 'integer':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'enum':
      return typeof value === 'string' && param.values.includes(value)
        ? null
        : `must be one of ${param.values.join(', ')}`;
    case 'path':
      return typeof value === 'string' &&
        /^\/[A-Za-z0-9\-._~/%]*$/.test(value) &&
        value.length <= 200
        ? null
        : 'must be a path without query';
    default:
      return 'unknown parameter type';
  }
}

/**
 * The typed parameters of strategy `id` as selected by `pack`, defaults applied and numbers
 * clamped to the binary's bounds; `null` when the pack does not select it. A value of the wrong
 * type reads as the default (a pack carrying one is refused by `refinePack` anyway).
 */
export function strategyOf<K extends StrategyId>(
  pack: SitePackV1,
  id: K,
): StrategyParams[K] | null {
  const entry = pack.strategies.find((s) => s.id === id);
  if (entry === undefined) return null;
  return paramsOf(id, entry.params, pack);
}

/** {@link strategyOf} for parameters already in hand (the classifier compares two versions). */
export function paramsOf<K extends StrategyId>(
  id: K,
  raw: RawParams,
  pack: Pick<SitePackV1, 'pacing' | 'keeper'>,
): StrategyParams[K] {
  const parsed: StrategyParams[StrategyId] = parseParams(id, raw, pack);
  // `parseParams` builds the record of `id` from the same table; the key is the discriminant.
  return parsed as StrategyParams[K];
}

function parseParams(
  id: StrategyId,
  raw: RawParams,
  pack: Pick<SitePackV1, 'pacing' | 'keeper'>,
): StrategyParams[StrategyId] {
  const int = (name: string, fallback: number, min: number, max: number) =>
    clampInt(raw[name], fallback, min, max);
  switch (id) {
    case 'pace-writes':
    case 'humanize-input':
    case 'device-bound-session':
    case 'single-focus':
      return {};
    case 'launch-spacing':
      return {
        minGapS: int('min_gap_s', pack.pacing?.min_launch_gap_s ?? 0, 0, 3600),
        jitterPct: int('jitter_pct', 20, 0, 50),
      };
    case 'ramp-up':
      return {
        days: int('days', 14, 1, 90),
        startFraction: clampNum(raw['start_fraction'], 0.3, 0.1, 1),
      };
    case 'serialize-site':
      return { maxParallel: int('max_parallel', 1, 1, 5) };
    case 'human-dwell': {
      const minMs = int('min_ms', 600, 0, 10_000);
      return { minMs, maxMs: int('max_ms', Math.max(2500, minMs), minMs, 20_000) };
    }
    case 'entry-warmup': {
      const path = raw['path'];
      const referrer = raw['referrer'];
      return {
        path: typeof path === 'string' && /^\/[A-Za-z0-9\-._~/%]*$/.test(path) ? path : '/',
        dwellMs: int('dwell_ms', 2000, 500, 10_000),
        referrer: referrer === 'same-site' || referrer === 'search' ? referrer : 'none',
      };
    }
    case 'keep-alive':
      return { intervalH: int('interval_h', pack.keeper?.interval_hours ?? 24, 6, 168) };
    case 'active-hours':
      return {
        startHour: int('start_hour', 8, 0, 23),
        endHour: int('end_hour', 22, 0, 23),
        weekdaysOnly: raw['weekdays_only'] === true,
      };
    case 'stealth-profile': {
      const fingerprint = raw['fingerprint'];
      return {
        minLevel: raw['min_level'] === 'max' ? 'max' : 'standard',
        fingerprint:
          fingerprint === 'required' || fingerprint === 'forbidden' ? fingerprint : 'any',
        humanize: raw['humanize'] === true,
      };
    }
    case 'webrtc-policy':
      return {
        policy:
          raw['policy'] === 'disable_non_proxied_udp'
            ? 'disable_non_proxied_udp'
            : 'default_public_interface_only',
      };
    default:
      return assertNeverId(id);
  }
}

function assertNeverId(id: never): never {
  throw new Error(`unknown strategy ${String(id)}`);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The `ramp-up` factor for a template `ageMs` old (spec 13 §9.4): `start_fraction + (1 −
 * start_fraction) × age_days / days`, 1 once the ramp is over.
 */
export function rampFactor(params: StrategyParams['ramp-up'], ageMs: number): number {
  const ageDays = Math.max(0, ageMs) / 86_400_000;
  if (ageDays >= params.days) return 1;
  return params.startFraction + ((1 - params.startFraction) * ageDays) / params.days;
}

/** A limit scaled by a ramp factor, rounded up, never below 1. */
export function rampedLimit(limit: number, factor: number): number {
  // 10 × 0.6 is 6.000000000000001 in floating point: round away the representation error first.
  return Math.max(1, Math.ceil(limit * factor - 1e-9));
}

/** Hours in an `active-hours` window (1–23; wrapping past midnight allowed). */
export function activeWindowHours(params: StrategyParams['active-hours']): number {
  return (params.endHour - params.startHour + 24) % 24;
}
