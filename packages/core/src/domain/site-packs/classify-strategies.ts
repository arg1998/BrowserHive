/** @module domain/site-packs/classify-strategies — spec 13 §9.7 for `strategies`: a strategy added tightens (an `active-hours` added, or a `stealth-profile` floor above a using template's settings, is restrictive; one naming a path loosens), removed loosens; each parameter moves along its safe direction from `STRATEGY_SPECS` (compared after defaults and clamping), `active-hours`' window by its own rule, and a parameter without a rule or safe direction loosens. */

import { type SitePackV1, STRATEGY_IDS, type StrategyId } from '@browserhive/contracts/site-packs';
import { assertNever } from '../../kernel/errors/app-error.ts';
import type { ChangeClass, ClassifyInput } from './classify-types.ts';
import { packFloorIssues } from './stealth-floor.ts';
import {
  activeWindowHours,
  paramsOf,
  STRATEGY_SPECS,
  type StrategyParamSpec,
  type StrategyParams,
} from './strategy-specs.ts';

type StrategyEntry = SitePackV1['strategies'][number];

/** A window this short (hours) leaves the site nearly unusable: restrictive. */
export const ACTIVE_HOURS_RESTRICTIVE_BELOW = 4;

/** One change of a strategy: `rest` is `''` for the whole entry, else `params.<name>`. */
export function classifyStrategyChange(
  id: string,
  rest: string,
  input: ClassifyInput,
): ChangeClass {
  if (!isStrategyId(id)) return 'loosening';
  const before = input.from.strategies.find((s) => s.id === id);
  const after = input.to.strategies.find((s) => s.id === id);
  if (rest === '') {
    if (before !== undefined || after === undefined) return 'loosening';
    return addedClass(id, after, input);
  }
  if (before === undefined || after === undefined || !rest.startsWith('params.')) {
    return 'loosening';
  }
  const name = rest.slice('params.'.length);
  const spec = STRATEGY_SPECS[id].params.find((p) => p.name === name);
  if (spec === undefined) return 'loosening';
  if (id === 'active-hours' && (name === 'start_hour' || name === 'end_hour')) {
    return windowClass(before, after, input);
  }
  const moved = paramClass(
    spec,
    typedValue(id, spec, before, input.from),
    typedValue(id, spec, after, input.to),
  );
  return id === 'stealth-profile' && moved === 'tightening' && floorAboveTemplates(input)
    ? 'restrictive'
    : moved;
}

function isStrategyId(id: string): id is StrategyId {
  return (STRATEGY_IDS as readonly string[]).includes(id);
}

function addedClass(id: StrategyId, entry: StrategyEntry, input: ClassifyInput): ChangeClass {
  // A path the strategy loads (entry-warmup's `path`) is path-bearing: loosening, whatever else.
  const namesPath = STRATEGY_SPECS[id].params.some(
    (p) => p.type === 'path' && entry.params[p.name] !== undefined,
  );
  if (namesPath) return 'loosening';
  if (id === 'active-hours') return 'restrictive';
  if (id === 'stealth-profile' && floorAboveTemplates(input)) return 'restrictive';
  return 'tightening';
}

/** True when a template using the pack is below the candidate's `stealth-profile` floor. */
function floorAboveTemplates({ to, ctx }: ClassifyInput): boolean {
  return ctx.usingTemplates.some((t) => packFloorIssues(t, to).length > 0);
}

/** `snake_case` parameter name → the typed record's `camelCase` key. */
function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** A parameter's value as the binary reads it: default applied, clamped to its bounds. */
function typedValue(
  id: StrategyId,
  spec: StrategyParamSpec,
  entry: StrategyEntry,
  pack: SitePackV1,
): unknown {
  const typed: Readonly<Record<string, unknown>> = paramsOf(id, entry.params, pack);
  return typed[camel(spec.name)];
}

/** A parameter moved: along its safe direction tightens, else loosens; unmoved is neutral. */
function paramClass(spec: StrategyParamSpec, from: unknown, to: unknown): ChangeClass {
  if (from === to) return 'neutral';
  if (spec.type === 'path') return 'loosening';
  const safe = spec.safe;
  switch (safe.kind) {
    case 'none':
      return 'loosening';
    case 'toward':
      return to === safe.value ? 'tightening' : 'loosening';
    case 'away':
      return from === safe.value ? 'tightening' : 'loosening';
    case 'up':
      return compare(spec, from, to) > 0 ? 'tightening' : 'loosening';
    case 'down':
      return compare(spec, from, to) < 0 ? 'tightening' : 'loosening';
    default:
      return assertNever(safe);
  }
}

/** The sign of `to − from` along the parameter's order; `0` when they cannot be ordered. */
function compare(spec: StrategyParamSpec, from: unknown, to: unknown): number {
  if (spec.type === 'boolean') {
    return typeof from === 'boolean' && typeof to === 'boolean' ? Number(to) - Number(from) : 0;
  }
  if (spec.type === 'enum') {
    const a = typeof from === 'string' ? spec.values.indexOf(from) : -1;
    const b = typeof to === 'string' ? spec.values.indexOf(to) : -1;
    return a < 0 || b < 0 ? 0 : Math.sign(b - a);
  }
  return typeof from === 'number' && typeof to === 'number' ? Math.sign(to - from) : 0;
}

/** The hours of an `active-hours` window, wrapping past midnight. */
function windowHours(params: StrategyParams['active-hours']): Set<number> {
  const hours = new Set<number>();
  const length = activeWindowHours(params);
  for (let i = 0; i < length; i++) hours.add((params.startHour + i) % 24);
  return hours;
}

/**
 * `active-hours` start or end moved (spec 13 §9.7): the window shortened inside the old one is
 * tightening, restrictive below {@link ACTIVE_HOURS_RESTRICTIVE_BELOW} h; longer or shifted is
 * loosening.
 */
function windowClass(
  before: StrategyEntry,
  after: StrategyEntry,
  input: ClassifyInput,
): ChangeClass {
  const a = windowHours(paramsOf('active-hours', before.params, input.from));
  const b = windowHours(paramsOf('active-hours', after.params, input.to));
  const inside = [...b].every((h) => a.has(h));
  if (!inside) return 'loosening';
  if (b.size === a.size) return 'neutral';
  return b.size < ACTIVE_HOURS_RESTRICTIVE_BELOW ? 'restrictive' : 'tightening';
}
