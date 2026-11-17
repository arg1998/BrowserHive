/** @module app/site-packs/strategy-views — `GET /site-packs/strategies` (spec 13 §9.4, §11.1): the closed strategy set of this binary as the wire shows it, each parameter with its default, bounds and safe direction, so the dashboard and the CLI can describe a pack's strategies. */

import type { SiteStrategiesResponse, SiteStrategyParam } from '@browserhive/contracts/http';
import {
  STRATEGY_SPEC_LIST,
  type StrategyParamSpec,
} from '../../domain/site-packs/strategy-specs.ts';
import { assertNever } from '../../kernel/errors/app-error.ts';

/** Every strategy compiled into this binary, in the table's order. */
export function strategyViews(): SiteStrategiesResponse {
  return {
    data: STRATEGY_SPEC_LIST.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      kind: s.kind,
      hooks: [...s.hooks],
      params: s.params.map(paramView),
    })),
  };
}

function paramView(p: StrategyParamSpec): SiteStrategyParam {
  const safe = p.safe;
  const safeValue = safe.kind === 'toward' || safe.kind === 'away' ? safe.value : null;
  const base = { name: p.name, safe_direction: safe.kind, safe_value: safeValue };
  switch (p.type) {
    case 'integer':
    case 'number':
      return {
        ...base,
        type: p.type,
        default: p.default,
        default_from: p.defaultFrom ?? null,
        fallback: p.fallback ?? null,
        min: p.min,
        min_from: p.minFrom ?? null,
        max: p.max,
        values: null,
      };
    case 'boolean':
    case 'path':
      return {
        ...base,
        type: p.type,
        default: p.default,
        default_from: null,
        fallback: null,
        min: null,
        min_from: null,
        max: null,
        values: null,
      };
    case 'enum':
      return {
        ...base,
        type: 'enum',
        default: p.default,
        default_from: null,
        fallback: null,
        min: null,
        min_from: null,
        max: null,
        values: [...p.values],
      };
    default:
      return assertNever(p);
  }
}
