/** @module domain/site-packs/strategy-specs — the closed strategy set compiled into the binary (spec 13 §9.4): each strategy's title, kind, hooks and parameters with their defaults, bounds and safe direction (used by `classifyPackChange`, §9.7), (the typed, clamped parameters are in `strategy-params.ts`). A pack selects strategies by id; it never carries behaviour. */

import type { StrategyId } from '@browserhive/contracts/site-packs';

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
      "Only the site's page the template's sessions acted on last keeps focus; the site's other pages report that they do not have focus, so the site never sees several focused tabs of one account.",
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
