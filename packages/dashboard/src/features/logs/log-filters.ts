/** @module features/logs/log-filters — the `/logs` filters sent to the server and their exact client-side mirror for live records (module = root prefix, `q` = substring over the record JSON), buffer keys, module roots, and the runtime log level spec grammar */
import type { LogLevel } from '@browserhive/contracts/enums';
import type { LogRecord } from '@browserhive/contracts/http';
import type { LogsSearch } from './search.ts';

/** Filters sent to `GET /logs` and `GET /logs/export`. */
export function logsFilters(search: LogsSearch) {
  return {
    ...(search.level !== undefined && { level: search.level }),
    ...(search.module !== undefined && { module: search.module }),
    ...(search.session_id !== undefined && { session_id: search.session_id }),
    ...(search.trace_id !== undefined && { trace_id: search.trace_id }),
    ...(search.request_id !== undefined && { request_id: search.request_id }),
    ...(search.q !== undefined && { q: search.q }),
    ...(search.since !== undefined && { since: search.since }),
    ...(search.until !== undefined && { until: search.until }),
  };
}

/** Stable key of the filter set (the buffer restarts when it changes). */
export function logsFilterKey(search: LogsSearch): string {
  const filters: Record<string, unknown> = logsFilters(search);
  return JSON.stringify(
    Object.keys(filters)
      .sort()
      .map((k) => [k, filters[k]]),
  );
}

/** `true` when any filter is active. */
export function hasLogsFilters(search: LogsSearch): boolean {
  return Object.keys(logsFilters(search)).length > 0;
}

/** `sessions.lifecycle` → `sessions`. */
export function moduleRoot(module: string): string {
  const dot = module.indexOf('.');
  return dot === -1 ? module : module.slice(0, dot);
}

/** Server rule: `sessions` matches `sessions` and `sessions.*`. */
export function moduleMatches(module: string, filters: readonly string[]): boolean {
  return filters.some((m) => module === m || module.startsWith(`${m}.`));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Does a live record pass the URL filters? Mirrors the ring-buffer predicate of `GET /logs` exactly. */
export function matchesLogFilters(record: LogRecord, search: LogsSearch): boolean {
  if (search.level !== undefined && !search.level.includes(record.level)) return false;
  if (search.module !== undefined && !moduleMatches(record.module, search.module)) return false;
  if (search.session_id !== undefined && record.session_id !== search.session_id) return false;
  if (search.trace_id !== undefined && record.trace_id !== search.trace_id) return false;
  if (search.request_id !== undefined && record.request_id !== search.request_id) return false;
  if (search.since !== undefined && record.ts < search.since) return false;
  if (search.until !== undefined && record.ts > search.until) return false;
  if (search.q !== undefined) {
    const needle = search.q.toLowerCase();
    if (!`${record.msg} ${safeJson(record)}`.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** Levels, most to least severe. */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

function isLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Runtime log level: a root level plus per-module overrides. */
export interface LogLevelSetting {
  readonly root: LogLevel;
  readonly overrides: readonly { readonly module: string; readonly level: LogLevel }[];
}

/** Read the canonical `logLevel` config value (`{root, modules}` or a spec string). */
export function readLogLevel(value: unknown): LogLevelSetting | undefined {
  if (typeof value === 'string') return parseLogLevelSpec(value);
  if (typeof value !== 'object' || value === null) return undefined;
  const root = (value as { root?: unknown }).root;
  if (!isLevel(root)) return undefined;
  const modules = (value as { modules?: unknown }).modules;
  const overrides =
    typeof modules === 'object' && modules !== null
      ? Object.entries(modules)
          .filter((entry): entry is [string, LogLevel] => isLevel(entry[1]))
          .map(([module, level]) => ({ module, level }))
      : [];
  return { root, overrides };
}

/** Module names the spec grammar accepts (roots only). */
export const LOG_MODULE_RE = /^[a-z][a-z0-9-]*$/;

/** Parse `info,sessions=debug`; `undefined` when it does not match the grammar. */
export function parseLogLevelSpec(spec: string): LogLevelSetting | undefined {
  const [root, ...rest] = spec.trim().split(',');
  if (!isLevel(root)) return undefined;
  const overrides: { module: string; level: LogLevel }[] = [];
  for (const part of rest) {
    const [module, level, extra] = part.split('=');
    if (
      module === undefined ||
      !LOG_MODULE_RE.test(module) ||
      !isLevel(level) ||
      extra !== undefined
    )
      return undefined;
    overrides.push({ module, level });
  }
  return { root, overrides };
}

/** Render a setting back to the spec grammar. */
export function formatLogLevelSpec(setting: LogLevelSetting): string {
  return [setting.root, ...setting.overrides.map((o) => `${o.module}=${o.level}`)].join(',');
}

/** Message shown for a module name the grammar rejects. */
export const MODULE_HINT = 'Module names are lowercase roots such as sessions or http.';

/** Validate a draft; returns the spec or the first problem. */
export function draftSpec(draft: {
  readonly root: LogLevel;
  readonly overrides: readonly { readonly module: string; readonly level: LogLevel }[];
}): { readonly spec: string } | { readonly error: string } {
  const seen = new Set<string>();
  for (const o of draft.overrides) {
    const module = o.module.trim();
    if (!LOG_MODULE_RE.test(module)) return { error: MODULE_HINT };
    if (seen.has(module)) return { error: `${module} is listed twice.` };
    seen.add(module);
  }
  return {
    spec: formatLogLevelSpec({
      root: draft.root,
      overrides: draft.overrides.map((o) => ({ module: o.module.trim(), level: o.level })),
    }),
  };
}
