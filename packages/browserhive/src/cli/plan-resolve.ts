/** @module cli/plan-resolve — what the planner's per-command steps share: the planning input, usage and config-failure exits, the run plan, and resolving the full configuration or only the data directory */
import type { ConfigFailure, ConfigFs, ResolvedConfigBundle } from '@browserhive/core/config';
import { resolveConfig } from '@browserhive/core/config';
import type { HostEnvironment } from '@browserhive/core/ports/host-environment';
import { type CliPlan, EXIT, type Invocation } from './invocation.ts';
import type { ColorMode } from './output/style.ts';
import { type FlagReader, serverArgv, type tokenizeCli } from './plan-args.ts';

/** Environment facts `planCli` needs besides argv/env/fs. */
export interface PlanContext {
  readonly cwd: string;
  readonly host: HostEnvironment;
  /** Logger module names for `logLevel` validation (`LOG_MODULES`). */
  readonly knownLogModules?: readonly string[];
}

/** Environment variables as the planner reads them. */
export type Env = Readonly<Record<string, string | undefined>>;

/** One invocation's planning input: tokens, environment, flag reader and positionals. */
export interface PlanInput {
  readonly tokens: ReturnType<typeof tokenizeCli>;
  readonly env: Env;
  readonly fs: ConfigFs;
  readonly context: PlanContext;
  readonly reader: FlagReader;
  readonly args: readonly string[];
  readonly color: ColorMode;
}

/**
 * A usage error (64) with every line prefixed.
 *
 * @returns The exit plan.
 */
export function usage(lines: readonly string[]): CliPlan {
  return { kind: 'exit', code: EXIT.usage, lines: lines.map((line) => `browserhive: ${line}`) };
}

/**
 * A configuration failure: 3 for a policy refusal, 64 otherwise.
 *
 * @returns The exit plan.
 */
export function failurePlan(failure: ConfigFailure): CliPlan {
  return {
    kind: 'exit',
    code: failure.exitCode === 3 ? EXIT.policy : EXIT.usage,
    lines: failure.render().split('\n'),
  };
}

/**
 * The full configuration, as `serve` would resolve it.
 *
 * @returns The resolver outcome.
 */
export function resolveFull(input: PlanInput): ReturnType<typeof resolveConfig> {
  return resolveConfig({
    argv: serverArgv(input.tokens),
    env: input.env,
    cwd: input.context.cwd,
    host: input.context.host,
    fs: input.fs,
    ...(input.context.knownLogModules !== undefined && {
      knownLogModules: input.context.knownLogModules,
    }),
  });
}

const DATA_DIR_ENV = ['BROWSERHIVE_DATA_DIR', 'BROWSERHIVE_CONFIG', 'BROWSERHIVE_COLOR'] as const;

/**
 * Resolves only `dataDir` (with `config` and `color`): unrelated invalid keys never block purge,
 * db or admin. A broken discovered config file falls back to env/flags/OS default.
 */
export function resolveDataDir(input: PlanInput): ReturnType<typeof resolveConfig> {
  const scopedEnv: Record<string, string | undefined> = {};
  for (const name of DATA_DIR_ENV) {
    if (input.env[name] !== undefined) scopedEnv[name] = input.env[name];
  }
  const base = {
    argv: serverArgv(input.tokens),
    env: scopedEnv,
    cwd: input.context.cwd,
    host: input.context.host,
    fs: input.fs,
  };
  const withFile = resolveConfig(base);
  if (withFile.ok) return withFile;
  const explicit =
    input.tokens.flags.has('config') || scopedEnv['BROWSERHIVE_CONFIG'] !== undefined;
  if (explicit) return withFile;
  const withoutFile = resolveConfig({ ...base, configFile: false });
  return withoutFile.ok ? withoutFile : withFile;
}

/**
 * A run plan.
 *
 * @returns The plan.
 */
export function run(invocation: Invocation, color: ColorMode, stdio = false): CliPlan {
  return { kind: 'run', invocation, color, stdio };
}

/**
 * The colour mode: the planned one, else the resolved `color` key.
 *
 * @returns The colour mode.
 */
export function colorOf(resolved: ResolvedConfigBundle, planned: ColorMode): ColorMode {
  return planned !== 'auto' ? planned : resolved.config.color;
}

/**
 * The OS default data directory (no file, env or flags), for a doctor run with a broken config.
 *
 * @returns The data directory.
 */
export function fallbackDataDir(input: PlanInput): string {
  const resolved = resolveConfig({
    argv: [],
    env: {},
    cwd: input.context.cwd,
    host: input.context.host,
    fs: input.fs,
    configFile: false,
  });
  return resolved.ok ? resolved.value.config.dataDir : input.context.cwd;
}
