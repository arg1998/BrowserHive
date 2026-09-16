/** @module infra/logging/level-spec — `info,sessions=debug` level-spec grammar and the module registry (spec 10 §4.1). */

import { err, ok, type Result } from '../../kernel/result.ts';
import type { LogLevel } from '../../ports/logger.ts';

/** All levels, most to least severe. */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

/** Numeric rank: a record is emitted when its rank ≤ the threshold's rank. */
export const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/**
 * Module names accepted in a level spec (spec 10 §4.1 list plus the cross-cutting modules that
 * log at boot). A logger's `module` binding is `<name>` or `<name>.<sub>`; only `<name>` is
 * matched.
 */
export const LOG_MODULES: readonly string[] = [
  'sessions',
  'browsers',
  'persistence',
  'http',
  'ws',
  'mcp',
  'vault',
  'attention',
  'auth',
  'telemetry',
  'retention',
  'dashboard',
  'config',
  'blocklist',
  'notifications',
  'system',
  'cli',
];

/** A parsed level spec: a default threshold plus per-module overrides. */
export interface LevelSpec {
  readonly default: LogLevel;
  readonly modules: Readonly<Record<string, LogLevel>>;
}

/** Type guard for {@link LogLevel}. */
export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Lifts a bare level (or an existing spec) into a {@link LevelSpec}. */
export function toLevelSpec(input: LogLevel | LevelSpec): LevelSpec {
  return typeof input === 'string' ? { default: input, modules: {} } : input;
}

/**
 * Parses `info` or `info,sessions=debug,http=warn`. The first entry must be a bare level; each
 * following entry is `<module>=<level>` with `<module>` from {@link LOG_MODULES}.
 *
 * @returns `Err` with a usage-error sentence naming the offending token.
 */
export function parseLevelSpec(text: string): Result<LevelSpec, string> {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const head = parts[0];
  if (head === undefined) return err('empty level spec');
  const defaultLevel = head.toLowerCase();
  if (!isLogLevel(defaultLevel)) {
    return err(`unknown level '${head}' (expected one of ${LOG_LEVELS.join(', ')})`);
  }
  const modules: Record<string, LogLevel> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) return err(`expected '<module>=<level>' but got '${part}'`);
    const module = part.slice(0, eq).trim();
    const level = part
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (!LOG_MODULES.includes(module)) {
      return err(`unknown log module '${module}' (expected one of ${LOG_MODULES.join(', ')})`);
    }
    if (!isLogLevel(level)) {
      return err(`unknown level '${level}' for module '${module}'`);
    }
    modules[module] = level;
  }
  return ok({ default: defaultLevel, modules });
}

/** Inverse of {@link parseLevelSpec}: `info,sessions=debug`. Modules are sorted for stability. */
export function formatLevelSpec(spec: LevelSpec): string {
  const overrides = Object.keys(spec.modules)
    .sort()
    .map((m) => `${m}=${spec.modules[m] ?? spec.default}`);
  return [spec.default, ...overrides].join(',');
}

/** Top-level module of a `module` binding (`sessions.lifecycle` → `sessions`). */
export function moduleRoot(module: string | undefined): string | undefined {
  if (module === undefined || module.length === 0) return undefined;
  const dot = module.indexOf('.');
  return dot === -1 ? module : module.slice(0, dot);
}

/** The threshold that applies to `module` under `spec`. */
export function effectiveLevel(spec: LevelSpec, module: string | undefined): LogLevel {
  const root = moduleRoot(module);
  if (root === undefined) return spec.default;
  return spec.modules[root] ?? spec.default;
}

/** True when a record at `level` passes a `threshold`. */
export function levelEnabled(threshold: LogLevel, level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[threshold];
}
