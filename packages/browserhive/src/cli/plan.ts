/** @module cli/plan — `planCli`: pure argv → `CliPlan` with the precedence help > version > unknown flags (64) > command > stray flags (64) > config (64) > policy guards (3) > run (spec 08 §7, spec 09 §3.3) */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { lookupKey } from '@browserhive/contracts/config';
import { Channel } from '@browserhive/contracts/enums';
import type { ConfigFailure, ConfigFs, ResolvedConfigBundle } from '@browserhive/core/config';
import { keyKind, resolveConfig } from '@browserhive/core/config';
import type { HostEnvironment } from '@browserhive/core/ports/host-environment';
import { type CliPlan, EXIT, type Invocation, type RemoteTarget } from './invocation.ts';
import type { ColorMode } from './output/style.ts';
import {
  FlagReader,
  isAccepted,
  lastValue,
  matchSubcommand,
  serverArgv,
  strayFlagMessage,
  tokenizeCli,
  unknownCommandMessage,
  unknownFlagMessage,
} from './plan-args.ts';
import { acceptedFlags, type CommandName, commandDescriptor, isCommandName } from './registry.ts';

/** Environment facts `planCli` needs besides argv/env/fs. */
export interface PlanContext {
  readonly cwd: string;
  readonly host: HostEnvironment;
  /** Logger module names for `logLevel` validation (`LOG_MODULES`). */
  readonly knownLogModules?: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const COLOR_MODES: readonly ColorMode[] = ['auto', 'always', 'never'];

function isColorMode(value: string | undefined): value is ColorMode {
  return value !== undefined && (COLOR_MODES as readonly string[]).includes(value);
}

function usage(lines: readonly string[]): CliPlan {
  return { kind: 'exit', code: EXIT.usage, lines: lines.map((line) => `browserhive: ${line}`) };
}

function failurePlan(failure: ConfigFailure): CliPlan {
  return {
    kind: 'exit',
    code: failure.exitCode === 3 ? EXIT.policy : EXIT.usage,
    lines: failure.render().split('\n'),
  };
}

/**
 * Plans one CLI run. Pure: reads only its arguments (the config file through `fs`).
 *
 * @returns The plan: help, version, a terminating exit, or a runnable invocation.
 */
export function planCli(
  argv: readonly string[],
  env: Env,
  fs: ConfigFs,
  context: PlanContext,
): CliPlan {
  const first = argv[0];
  const commandWord = first !== undefined && isCommandName(first) ? first : null;
  const command: CommandName = commandWord ?? 'serve';
  const tokens = tokenizeCli(commandWord === null ? argv : argv.slice(1));
  const flagColor = lastValue(tokens, 'color');
  const envColor = env['BROWSERHIVE_COLOR'];
  const color: ColorMode = isColorMode(flagColor)
    ? flagColor
    : isColorMode(envColor)
      ? envColor
      : 'auto';

  // 1. help (wins over everything, including errors)
  const descriptor = commandDescriptor(command);
  if (command === 'help' || tokens.flags.has('help') || tokens.shortFlags.includes('-h')) {
    if (commandWord === null) {
      return { kind: 'help', topic: { command: null, subcommand: null }, color };
    }
    return helpPlan(command, tokens.positionals, color);
  }
  // 2. version
  if (tokens.flags.has('version') || tokens.shortFlags.includes('-v')) {
    return { kind: 'version', json: tokens.flags.has('json'), color };
  }

  // 3. unknown flags and unknown command words (all reported)
  const matched = matchSubcommand(descriptor, tokens.positionals);
  const subcommand = matched.ok ? matched.subcommand : undefined;
  const invocationName =
    subcommand === undefined ? command : `${command} ${subcommand.words.join(' ')}`;
  const accepted = acceptedFlags(descriptor, subcommand);
  const unknown: string[] = [];
  if (commandWord === null && first !== undefined && !first.startsWith('-')) {
    unknown.push(unknownCommandMessage(first));
  }
  for (const flag of tokens.unknown) {
    unknown.push(unknownFlagMessage(flag, accepted, commandWord === null ? null : invocationName));
  }
  for (const flag of tokens.shortFlags) {
    unknown.push(unknownFlagMessage(flag, accepted, commandWord === null ? null : invocationName));
  }
  if (unknown.length > 0) return usage(unknown);

  // 4. command / subcommand / positional arguments
  if (!matched.ok) return usage([matched.message]);
  const args = matched.args;
  const expected = subcommand?.args ?? [];
  const missing = expected.filter((arg, index) => arg.required && args[index] === undefined);
  const firstMissing = missing[0];
  if (firstMissing !== undefined) {
    return usage([`'${invocationName}' requires a ${firstMissing.name} argument.`]);
  }
  const extra = args[expected.length];
  if (extra !== undefined) {
    const hint =
      invocationName === 'serve'
        ? "'browserhive --help'"
        : `'browserhive ${invocationName} --help'`;
    const booleanFlag = booleanFlagBefore(argv, extra);
    if (booleanFlag !== null) {
      // Spec 08 §2: booleans never take a space-separated value, so they cannot swallow a positional.
      return usage([
        `${booleanFlag} is a boolean flag and takes no separate value: use ${booleanFlag} or ${booleanFlag}=${extra.toLowerCase()}.`,
      ]);
    }
    return usage([`unexpected argument '${extra}'. Run ${hint}.`]);
  }

  // 5. stray flags (known, but not this invocation's)
  const stray = [...tokens.flags.keys()]
    .filter((name) => !isAccepted(name, accepted))
    .map((name) => strayFlagMessage(name, invocationName));
  const missingValues = tokens.missingValue.map((flag) => `${flag} requires a value.`);
  if (stray.length > 0 || missingValues.length > 0) return usage([...stray, ...missingValues]);

  // 6–7. configuration (64) and policy guards (3), then run
  const reader = new FlagReader(tokens);
  const input: PlanInput = { tokens, env, fs, context, reader, args, color };
  return planInvocation(subcommand === undefined ? command : invocationName, input);
}

interface PlanInput {
  readonly tokens: ReturnType<typeof tokenizeCli>;
  readonly env: Env;
  readonly fs: ConfigFs;
  readonly context: PlanContext;
  readonly reader: FlagReader;
  readonly args: readonly string[];
  readonly color: ColorMode;
}

function helpPlan(command: CommandName, positionals: readonly string[], color: ColorMode): CliPlan {
  if (command === 'help') {
    const topic = positionals[0];
    if (topic === undefined)
      return { kind: 'help', topic: { command: null, subcommand: null }, color };
    if (!isCommandName(topic)) return usage([unknownCommandMessage(topic)]);
    const matched = matchSubcommand(commandDescriptor(topic), positionals.slice(1));
    const words = matched.ok && positionals.length > 1 ? (matched.subcommand?.words ?? null) : null;
    return { kind: 'help', topic: { command: topic, subcommand: words }, color };
  }
  const matched = matchSubcommand(commandDescriptor(command), positionals);
  const words = matched.ok && positionals.length > 0 ? (matched.subcommand?.words ?? null) : null;
  return { kind: 'help', topic: { command, subcommand: words }, color };
}

function resolveFull(input: PlanInput): ReturnType<typeof resolveConfig> {
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
function resolveDataDir(input: PlanInput): ReturnType<typeof resolveConfig> {
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

function run(invocation: Invocation, color: ColorMode, stdio = false): CliPlan {
  return { kind: 'run', invocation, color, stdio };
}

function colorOf(resolved: ResolvedConfigBundle, planned: ColorMode): ColorMode {
  return planned !== 'auto' ? planned : resolved.config.color;
}

function remoteTarget(reader: FlagReader): RemoteTarget | null {
  const url = reader.url('url');
  const token = reader.text('token');
  const cookie = reader.text('cookie');
  if (url === undefined) {
    if (token !== undefined) reader.problems.push('--token requires --url.');
    if (cookie !== undefined) reader.problems.push('--cookie requires --url.');
    return null;
  }
  return { url, ...(token !== undefined && { token }), ...(cookie !== undefined && { cookie }) };
}

function planInvocation(name: string, input: PlanInput): CliPlan {
  const { reader, color } = input;
  switch (name) {
    case 'serve': {
      const resolved = resolveFull(input);
      if (!resolved.ok) return failurePlan(resolved.error);
      const bundle = resolved.value;
      return run(
        { command: 'serve', resolved: bundle },
        colorOf(bundle, color),
        bundle.config.transport === 'stdio',
      );
    }
    case 'init': {
      reader.oneOf('browsers', ['chromium']);
      const force = reader.bool('force');
      const skipBrowsers = reader.bool('skipBrowsers');
      const writeSchema = reader.bool('writeSchema');
      const channel = reader.oneOf('channel', Channel.options);
      const installChrome = reader.bool('installChrome');
      const yes = reader.bool('yes');
      if (reader.problems.length > 0) return usage(reader.problems);
      const resolved = resolveFull(input);
      if (!resolved.ok) return failurePlan(resolved.error);
      return run(
        {
          command: 'init',
          resolved: resolved.value,
          force,
          skipBrowsers,
          writeSchema,
          channel: Channel.safeParse(channel).data ?? null,
          installChrome,
          yes,
        },
        colorOf(resolved.value, color),
      );
    }
    case 'doctor': {
      const json = reader.bool('json');
      const printApparmorProfile = reader.bool('printApparmorProfile');
      if (reader.problems.length > 0) return usage(reader.problems);
      const resolution = resolveFull(input);
      const scoped = resolution.ok ? resolution : resolveDataDir(input);
      const dir = scoped.ok ? scoped.value.config.dataDir : fallbackDataDir(input);
      return run(
        { command: 'doctor', json, printApparmorProfile, resolution, dataDir: dir },
        color,
      );
    }
    case 'config show':
    case 'config validate': {
      const json = name === 'config show' ? reader.bool('json') : false;
      if (reader.problems.length > 0) return usage(reader.problems);
      const resolved = resolveFull(input);
      if (!resolved.ok) return failurePlan(resolved.error);
      const bundle = resolved.value;
      return run(
        name === 'config show'
          ? { command: 'config-show', json, resolved: bundle }
          : { command: 'config-validate', resolved: bundle },
        colorOf(bundle, color),
      );
    }
    case 'config schema':
      return run({ command: 'config-schema' }, color);
    case 'version': {
      const json = reader.bool('json');
      if (reader.problems.length > 0) return usage(reader.problems);
      return run({ command: 'version', json }, color);
    }
    default:
      return planDataDirCommand(name, input);
  }
}

function fallbackDataDir(input: PlanInput): string {
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

function planDataDirCommand(name: string, input: PlanInput): CliPlan {
  const { reader, color, args } = input;
  const json = reader.bool('json');
  let invocation: ((dataDir: string) => Invocation) | undefined;
  switch (name) {
    case 'purge': {
      const all = reader.bool('all');
      const dryRun = reader.bool('dryRun');
      const yes = reader.bool('yes');
      invocation = (dataDir) => ({ command: 'purge', dataDir, all, dryRun, yes });
      break;
    }
    case 'db status':
      invocation = (dataDir) => ({ command: 'db-status', dataDir, json });
      break;
    case 'db backup': {
      const out = reader.text('out');
      const path =
        out === undefined ? null : isAbsolute(out) ? out : resolvePath(input.context.cwd, out);
      invocation = (dataDir) => ({ command: 'db-backup', dataDir, out: path });
      break;
    }
    case 'db restore': {
      const raw = args[0] ?? '';
      const file = isAbsolute(raw) ? raw : resolvePath(input.context.cwd, raw);
      const yes = reader.bool('yes');
      invocation = (dataDir) => ({ command: 'db-restore', dataDir, file, yes });
      break;
    }
    case 'db migrate': {
      const dryRun = reader.bool('dryRun');
      invocation = (dataDir) => ({ command: 'db-migrate', dataDir, dryRun, json });
      break;
    }
    case 'admin reset-password':
      invocation = (dataDir) => ({ command: 'admin-reset-password', dataDir, json });
      break;
    case 'admin tokens list': {
      const remote = remoteTarget(reader);
      invocation = (dataDir) => ({ command: 'admin-tokens-list', dataDir, json, remote });
      break;
    }
    case 'admin tokens create': {
      const expiresInMs = reader.duration('expiresIn') ?? null;
      const remote = remoteTarget(reader);
      const principal = args[0] ?? '';
      invocation = (dataDir) => ({
        command: 'admin-tokens-create',
        dataDir,
        principal,
        expiresInMs,
        json,
        remote,
      });
      break;
    }
    case 'admin tokens revoke': {
      const remote = remoteTarget(reader);
      const principal = args[0] ?? '';
      invocation = (dataDir) => ({
        command: 'admin-tokens-revoke',
        dataDir,
        principal,
        json,
        remote,
      });
      break;
    }
    default:
      invocation = undefined;
  }
  if (invocation === undefined) return usage([`unsupported invocation '${name}'.`]);
  if (reader.problems.length > 0) return usage(reader.problems);
  const resolved = resolveDataDir(input);
  if (!resolved.ok) return failurePlan(resolved.error);
  return run(invocation(resolved.value.config.dataDir), colorOf(resolved.value, color));
}

const BOOLEAN_WORDS = /^(true|false|1|0|yes|no|on|off)$/i;

/**
 * When `word` looks like a boolean and directly follows a boolean config flag (`--humanize true`),
 * returns that flag so the usage error can show the accepted spellings.
 */
function booleanFlagBefore(argv: readonly string[], word: string): string | null {
  if (!BOOLEAN_WORDS.test(word)) return null;
  const index = argv.indexOf(word);
  const previous = index > 0 ? argv[index - 1] : undefined;
  if (previous === undefined || !previous.startsWith('--') || previous.includes('=')) return null;
  const found = lookupKey('cli', previous);
  return found.kind === 'key' && keyKind(found.key) === 'boolean' ? previous : null;
}
