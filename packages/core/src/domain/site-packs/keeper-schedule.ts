/** @module domain/site-packs/keeper-schedule — when `keep-alive` visits a site (spec 13 §9.4): every `interval_h` ± 20 %, skipped when an agent session of the template loaded the site within the interval (the next visit is then one interval after that load). Pure. */

/** The keeper's interval jitter (± 20 %). */
export const KEEPER_JITTER = 0.2;

/** `interval_h` in milliseconds. */
export function keeperIntervalMs(intervalH: number): number {
  return intervalH * 3_600_000;
}

/** The interval with ± 20 % jitter (`random` in `[0, 1)`). */
export function jitteredKeeperMs(intervalH: number, random: number): number {
  const r = Math.min(1, Math.max(0, random));
  return Math.round(keeperIntervalMs(intervalH) * (1 - KEEPER_JITTER + 2 * KEEPER_JITTER * r));
}

/** What the keeper does for one site now. */
export type KeeperStep =
  | { readonly kind: 'wait' }
  /** An agent loaded the site within the interval: no visit; plan the next one after `from`. */
  | { readonly kind: 'skip'; readonly from: number }
  | { readonly kind: 'visit' };

/**
 * The step for a site due at `dueAt`: wait until then; skip when an agent session loaded the site
 * less than one (unjittered) interval ago; else visit.
 */
export function keeperStep(input: {
  readonly now: number;
  readonly dueAt: number;
  readonly lastAgentLoadAt: number | null;
  readonly intervalH: number;
}): KeeperStep {
  if (input.now < input.dueAt) return { kind: 'wait' };
  const last = input.lastAgentLoadAt;
  if (last !== null && input.now - last < keeperIntervalMs(input.intervalH)) {
    return { kind: 'skip', from: last };
  }
  return { kind: 'visit' };
}
