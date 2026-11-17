/** @module domain/site-packs/strategy-specs — the closed strategy set compiled into the binary (spec 13 §9.4): each strategy's title, kind, hooks and parameters with their defaults, bounds and safe direction (used by `classifyPackChange`, §9.7), and the typed, clamped parameters every runtime hook reads. A pack selects strategies by id; it never carries behaviour. */

import type { SitePackV1, StrategyId } from '@browserhive/contracts/site-packs';

/** Where a strategy acts (spec 13 §9.6 hook points). */
export type StrategyHook =
  | 'admit'
  | 'before_action'
  | 'request_guard'
  | 'response_observer'
  | 'keeper'
  | 'host_flags'
  | 'template_requirements'
  | 'page_focus';

/**
 * The direction in which a parameter may change without loosening the pack (spec 13 §9.7):
 * `up` (a larger number, `false → true`, a later value of an ordered enum), `down`, `toward` one
 * value, `away` from one value, or `none` (any change is loosening).
 */
export type SafeDirection =
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'none' }
  | { readonly kind: 'toward'; readonly value: string }
  | { readonly kind: 'away'; readonly value: string };

/** One parameter of a strategy. */
export type StrategyParamSpec =
  | {
      readonly name: string;
      readonly type: 'integer' | 'number';
      /** `null`: taken from the pack (`defaultFrom`), else `fallback`. */
      readonly default: number | null;
      readonly defaultFrom?: string;
      readonly fallback?: number;
      readonly min: number;
      readonly max: number;
      readonly safe: SafeDirection;
    }
  | {
      readonly name: string;
      readonly type: 'boolean';
      readonly default: boolean;
      readonly safe: SafeDirection;
    }
  | {
      readonly name: string;
      readonly type: 'enum';
      readonly default: string;
      /** In order: `up` means a later value. */
      readonly values: readonly string[];
      readonly safe: SafeDirection;
    }
  | {
      readonly name: string;
      readonly type: 'path';
      readonly default: string;
      /** A path names what BrowserHive loads: no safe direction (spec 13 §9.4). */
      readonly safe: { readonly kind: 'none' };
    };

/** One strategy of the closed set. */
export interface StrategySpec {
  readonly id: StrategyId;
  readonly title: string;
  readonly description: string;
  readonly kind: 'behaviour' | 'stealth';
  readonly hooks: readonly StrategyHook[];
  readonly params: readonly StrategyParamSpec[];
}

const UP = { kind: 'up' } as const;
const DOWN = { kind: 'down' } as const;
const NONE = { kind: 'none' } as const;

/** Every strategy compiled into this binary, keyed by id (exhaustive at compile time). */
export const STRATEGY_SPECS: { readonly [K in StrategyId]: StrategySpec } = {
  'pace-writes': {
    id: 'pace-writes',
    title: 'Pace writes',
    description:
      "Keeps the account within the pack's write budgets (pacing rules), shared by every session of the template: a write over budget waits for the next token when it is at most 60 s away, otherwise it is aborted.",
    kind: 'behaviour',
    hooks: ['request_guard'],
    params: [],
  },
  'launch-spacing': {
    id: 'launch-spacing',
    title: 'Space launches',
    description:
      'Spaces consecutive sessions of the template on this site; a launch waits up to 20 s for its turn, otherwise it is refused as busy with a retry time.',
    kind: 'behaviour',
    hooks: ['admit'],
    params: [
      {
        name: 'min_gap_s',
        type: 'integer',
        default: null,
        defaultFrom: 'pacing.min_launch_gap_s',
        fallback: 0,
        min: 0,
        max: 3600,
        safe: UP,
      },
      { name: 'jitter_pct', type: 'integer', default: 20, min: 0, max: 50, safe: UP },
    ],
  },
  'ramp-up': {
    id: 'ramp-up',
    title: 'Ramp up a new template',
    description:
      'For a template younger than the ramp, the session cap and every write budget are scaled down, growing linearly from the start fraction to the full value.',
    kind: 'behaviour',
    hooks: ['admit', 'request_guard'],
    params: [
      { name: 'days', type: 'integer', default: 14, min: 1, max: 90, safe: UP },
      { name: 'start_fraction', type: 'number', default: 0.3, min: 0.1, max: 1, safe: DOWN },
    ],
  },
  'serialize-site': {
    id: 'serialize-site',
    title: 'One action at a time',
    description:
      "At most this many sessions of the template act on the site's pages at once; others wait their turn (up to 30 s), like one person with many tabs.",
    kind: 'behaviour',
    hooks: ['before_action'],
    params: [{ name: 'max_parallel', type: 'integer', default: 1, min: 1, max: 5, safe: DOWN }],
  },
  'human-dwell': {
    id: 'human-dwell',
    title: 'Human dwell time',
    description:
      "Before an action on the site's pages, the session waits until a random dwell since its previous action on the site has passed.",
    kind: 'behaviour',
    hooks: ['before_action'],
    params: [
      { name: 'min_ms', type: 'integer', default: 600, min: 0, max: 10_000, safe: UP },
      { name: 'max_ms', type: 'integer', default: 2500, min: 0, max: 20_000, safe: UP },
    ],
  },
  'humanize-input': {
    id: 'humanize-input',
    title: 'Humanized input',
    description:
      "Moves the pointer and types like a person on the site's pages, whatever the session asked for (needs the template's stealth on).",
    kind: 'behaviour',
    hooks: ['before_action'],
    params: [],
  },
  'entry-warmup': {
    id: 'entry-warmup',
    title: 'Warm-up entry',
    description:
      "A session's first visit to the site that goes straight to a deep page first loads the entry path and dwells there, so the account does not arrive cold.",
    kind: 'behaviour',
    hooks: ['before_action'],
    params: [
      { name: 'path', type: 'path', default: '/', safe: NONE },
      { name: 'dwell_ms', type: 'integer', default: 2000, min: 500, max: 10_000, safe: UP },
      {
        name: 'referrer',
        type: 'enum',
        default: 'none',
        values: ['none', 'same-site', 'search'],
        safe: NONE,
      },
    ],
  },
  'keep-alive': {
    id: 'keep-alive',
    title: 'Keep the sign-in fresh',
    description:
      'A background page visits the site at the interval (± 20 %) when no session loaded it meanwhile, so rolling cookies stay fresh; the visit also checks the sign-in.',
    kind: 'behaviour',
    hooks: ['keeper'],
    params: [
      {
        name: 'interval_h',
        type: 'integer',
        default: null,
        defaultFrom: 'keeper.interval_hours',
        fallback: 24,
        min: 6,
        max: 168,
        safe: UP,
      },
    ],
  },
  'active-hours': {
    id: 'active-hours',
    title: 'Active hours',
    description:
      "New sessions start only inside the window, in the template's timezone; outside it a launch is refused as busy with the time until the window opens. Running sessions continue.",
    kind: 'behaviour',
    hooks: ['admit'],
    params: [
      { name: 'start_hour', type: 'integer', default: 8, min: 0, max: 23, safe: NONE },
      { name: 'end_hour', type: 'integer', default: 22, min: 0, max: 23, safe: NONE },
      { name: 'weekdays_only', type: 'boolean', default: false, safe: UP },
    ],
  },
  'device-bound-session': {
    id: 'device-bound-session',
    title: 'Detect device-bound sessions',
    description:
      'Watches the site’s responses for device-bound session headers (DBSC) and marks the site device-bound; it never changes a request.',
    kind: 'behaviour',
    hooks: ['response_observer'],
    params: [],
  },
  'stealth-profile': {
    id: 'stealth-profile',
    title: 'Stealth floor',
    description:
      "The template's stealth must be at least this level, its fingerprint noise must match unless 'any', and humanized input can be required; a template below the floor cannot enable the site.",
    kind: 'stealth',
    hooks: ['template_requirements'],
    params: [
      {
        name: 'min_level',
        type: 'enum',
        default: 'standard',
        values: ['standard', 'max'],
        safe: UP,
      },
      {
        name: 'fingerprint',
        type: 'enum',
        default: 'any',
        values: ['required', 'forbidden', 'any'],
        safe: { kind: 'away', value: 'any' },
      },
      { name: 'humanize', type: 'boolean', default: false, safe: UP },
    ],
  },
  'single-focus': {
    id: 'single-focus',
    title: 'One focused tab',
    description:
      "Only the site's page the template's sessions acted on last keeps focus; the site's other pages report their real visibility, so the site never sees several focused tabs of one account.",
    kind: 'stealth',
    hooks: ['page_focus'],
    params: [],
  },
  'webrtc-policy': {
    id: 'webrtc-policy',
    title: 'WebRTC address policy',
    description:
      "Limits which network addresses WebRTC exposes, for the whole browser of the template (the strictest policy of its sites); changing it restarts the template's browser.",
    kind: 'stealth',
    hooks: ['host_flags'],
    params: [
      {
        name: 'policy',
        type: 'enum',
        default: 'default_public_interface_only',
        values: ['default_public_interface_only', 'disable_non_proxied_udp'],
        safe: { kind: 'toward', value: 'disable_non_proxied_udp' },
      },
    ],
  },
};

/** The strategy ids in the table's order. */
export const STRATEGY_SPEC_LIST: readonly StrategySpec[] = Object.values(STRATEGY_SPECS);

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
  return Math.max(1, Math.ceil(limit * factor));
}

/** Hours in an `active-hours` window (1–23; wrapping past midnight allowed). */
export function activeWindowHours(params: StrategyParams['active-hours']): number {
  return (params.endHour - params.startHour + 24) % 24;
}
