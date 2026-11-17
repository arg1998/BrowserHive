/** @module features/site-packs/detail/strategy-model — a pack's strategy parameters as the binary reads them (spec 13 §9.4): the value the pack sets, else the default (or the pack field it defaults from), clamped to the bounds of `GET /site-packs/strategies` (a lower bound taken from another parameter, `min_from`, as `max_ms` ≥ `min_ms`, review #84 L3), with the bounds and safe direction in words */
import type { SiteStrategyParam } from '@browserhive/contracts/http';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';

/** One parameter of a pack's strategy, ready to show. */
export interface ParamRow {
  readonly name: string;
  /** The value in force, as text. */
  readonly value: string;
  /** Where the value comes from. */
  readonly origin: 'set' | 'default' | 'pack' | 'clamped';
  /** The raw value the pack set when it was clamped. */
  readonly raw: string | null;
  readonly defaultText: string;
  readonly bounds: string | null;
  readonly direction: string;
}

type Raw = number | boolean | string | undefined;

/** Reads `pacing.min_launch_gap_s` and `keeper.interval_hours` (the `default_from` fields). */
function packField(pack: SitePackV1, path: string): number | undefined {
  if (path === 'pacing.min_launch_gap_s') return pack.pacing?.min_launch_gap_s;
  if (path === 'keeper.interval_hours') return pack.keeper?.interval_hours;
  return undefined;
}

function text(value: Raw | null): string {
  if (value === undefined || value === null) return '—';
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

/** The safe direction in words (what change is stricter). */
export function directionText(param: SiteStrategyParam): string {
  switch (param.safe_direction) {
    case 'up':
      return param.type === 'boolean'
        ? 'Turning it on is stricter'
        : param.type === 'enum'
          ? 'Later values are stricter'
          : 'Higher is stricter';
    case 'down':
      return 'Lower is stricter';
    case 'toward':
      return `Stricter toward ${param.safe_value ?? '—'}`;
    case 'away':
      return `Stricter away from ${param.safe_value ?? '—'}`;
    case 'none':
      return 'Any change relaxes rules';
    default:
      return '';
  }
}

/** The bounds of a parameter in words ("min_ms–20000" when another parameter is the lower bound), or `null`. */
function boundsText(param: SiteStrategyParam): string | null {
  if (param.min !== null && param.max !== null) {
    return `${param.min_from ?? param.min}–${param.max}`;
  }
  if (param.values !== null) return param.values.join(' · ');
  if (param.type === 'path') return 'A path on the site';
  return null;
}

function defaultText(param: SiteStrategyParam): string {
  if (param.default !== null) return text(param.default);
  if (param.default_from !== null) {
    return `${param.default_from}${param.fallback === null ? '' : `, else ${param.fallback}`}`;
  }
  return '—';
}

/**
 * One parameter's row: the pack's value clamped to the binary's bounds, else the default.
 * `lower` is the value in force of the parameter `min_from` names, when there is one.
 */
export function paramRow(
  param: SiteStrategyParam,
  raw: Raw,
  pack: SitePackV1,
  lower?: number,
): ParamRow {
  const base = {
    name: param.name,
    defaultText: defaultText(param),
    bounds: boundsText(param),
    direction: directionText(param),
  };
  if (raw === undefined) {
    const fromPack = param.default_from === null ? undefined : packField(pack, param.default_from);
    if (fromPack !== undefined)
      return { ...base, value: text(fromPack), origin: 'pack', raw: null };
    const value = param.default ?? param.fallback;
    return { ...base, value: text(value ?? undefined), origin: 'default', raw: null };
  }
  if (typeof raw === 'number' && param.min !== null && param.max !== null) {
    const min = Math.max(param.min, lower ?? param.min);
    const clamped = Math.min(param.max, Math.max(min, raw));
    if (clamped !== raw) {
      return { ...base, value: text(clamped), origin: 'clamped', raw: text(raw) };
    }
  }
  return { ...base, value: text(raw), origin: 'set', raw: null };
}

/** Every parameter of a strategy with the pack's values; names the binary does not know are listed last. */
export function paramRows(
  params: readonly SiteStrategyParam[],
  values: Readonly<Record<string, number | boolean | string>>,
  pack: SitePackV1,
): readonly ParamRow[] {
  const inForce = new Map<string, number>();
  for (const p of params) {
    if (p.min_from !== null) continue;
    const value = Number(paramRow(p, values[p.name], pack).value);
    if (Number.isFinite(value)) inForce.set(p.name, value);
  }
  const known = params.map((p) =>
    paramRow(p, values[p.name], pack, p.min_from === null ? undefined : inForce.get(p.min_from)),
  );
  const unknown = Object.entries(values)
    .filter(([name]) => !params.some((p) => p.name === name))
    .map(
      ([name, value]): ParamRow => ({
        name,
        value: text(value),
        origin: 'set',
        raw: null,
        defaultText: '—',
        bounds: null,
        direction: 'Not known to this BrowserHive',
      }),
    );
  return [...known, ...unknown];
}
