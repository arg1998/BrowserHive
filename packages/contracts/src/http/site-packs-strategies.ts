/** @module contracts/http/site-packs-strategies — `GET /site-packs/strategies` (spec 13 §9.4, §11.1, PR T3b): the closed strategy set compiled into the running binary, with each parameter's default, bounds and safe direction, so the dashboard and CLI can show a pack's strategies as readable text. */
import { z } from 'zod';
import { StrategyId } from '../site-packs/schema.ts';

/** Where a strategy acts (spec 13 §9.6 hook points). */
export const SiteStrategyHook = z.enum([
  'admit',
  'before_action',
  'request_guard',
  'response_observer',
  'keeper',
  'host_flags',
  'template_requirements',
  'page_focus',
]);
/** A hook point. */
export type SiteStrategyHook = z.infer<typeof SiteStrategyHook>;

/**
 * The direction a parameter may move without loosening the pack (spec 13 §9.7): `up`, `down`,
 * `toward` / `away` from `safe_value`, or `none` (any change is loosening).
 */
export const SiteStrategySafeDirection = z.enum(['up', 'down', 'toward', 'away', 'none']);
/** A safe direction. */
export type SiteStrategySafeDirection = z.infer<typeof SiteStrategySafeDirection>;

/** One parameter of a strategy. */
export const SiteStrategyParam = z.object({
  name: z.string(),
  type: z.enum(['integer', 'number', 'boolean', 'enum', 'path']),
  /** `null`: taken from the pack field `default_from`, else `fallback`. */
  default: z.union([z.number(), z.boolean(), z.string()]).nullable(),
  default_from: z.string().nullable(),
  fallback: z.number().nullable(),
  min: z.number().nullable(),
  /** A parameter of the same strategy whose value in force is the lower bound (`max_ms` ≥ `min_ms`); `min` still holds. */
  min_from: z.string().nullable(),
  max: z.number().nullable(),
  /** Enum values, in order (`up` means a later one). */
  values: z.array(z.string()).nullable(),
  safe_direction: SiteStrategySafeDirection,
  safe_value: z.string().nullable(),
});
/** One parameter of a strategy. */
export type SiteStrategyParam = z.infer<typeof SiteStrategyParam>;

/** One strategy of the closed set. */
export const SiteStrategyView = z.object({
  id: StrategyId,
  title: z.string(),
  description: z.string(),
  kind: z.enum(['behaviour', 'stealth']),
  hooks: z.array(SiteStrategyHook),
  params: z.array(SiteStrategyParam),
});
/** One strategy of the closed set. */
export type SiteStrategyView = z.infer<typeof SiteStrategyView>;

/** `GET /site-packs/strategies` body. */
export const SiteStrategiesResponse = z.object({ data: z.array(SiteStrategyView) });
/** `GET /site-packs/strategies` body. */
export type SiteStrategiesResponse = z.infer<typeof SiteStrategiesResponse>;
