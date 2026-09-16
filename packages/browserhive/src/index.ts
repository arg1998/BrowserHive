/** @module browserhive — the programmatic API: `createServer(options)` over the same composition root as the CLI (spec 08 §9, spec 02 §9, spec 12 §12). */

import type {
  ConfigKey,
  Provenance,
  ServerConfig,
  ServerConfigInput,
} from '@browserhive/contracts/config';
import { CONFIG_KEYS } from '@browserhive/contracts/config';
import { VERSION } from '@browserhive/core';
import {
  type ConfigFailure,
  type ConfigOverrides,
  configFailure,
  resolveConfig,
  suggestKey,
  withSuggestion,
} from '@browserhive/core/config';
import {
  bootServer,
  buildHostEnvironment,
  LOG_MODULES,
  nodeConfigFs,
  type OutputSinks,
  processEnv,
  type RunningServer,
} from './composition/index.ts';
import { urlFor } from './composition/phases/listeners-http.ts';

export type { Provenance, ServerConfig, ServerConfigInput } from '@browserhive/contracts/config';
export type {
  ErrorCode,
  ErrorDetails,
  McpErrorContent,
  ProblemDetails,
} from '@browserhive/contracts/errors';
export { ERROR_CODES } from '@browserhive/contracts/errors';
export type {
  ToolAnnotations,
  ToolArgs,
  ToolContract,
  ToolContractOf,
  ToolName,
  ToolResult,
} from '@browserhive/contracts/tools';
export { ALL_TOOL_NAMES, TOOL_CONTRACTS } from '@browserhive/contracts/tools';
export { AppError, isAppError } from '@browserhive/core/runtime';
export { VERSION };

/** One redacted log record as an external sink receives it (spec 10 §4). */
export interface BrowserHiveLogRecord {
  readonly ts: number;
  readonly level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly msg: string;
  readonly module: string;
  readonly [field: string]: unknown;
}

/** External log sink (`logger` option): receives every record in addition to the normal stream. */
export interface BrowserHiveLogSink {
  write(record: BrowserHiveLogRecord): void;
  flush?(): Promise<void> | void;
}

/** The typed config keys (camelCase, canonical or grammar form, e.g. `sessionLease: '2h' | 7_200_000`). */
export type ServerOptions = { readonly [K in keyof ServerConfigInput]?: ServerConfigInput[K] };

/** Options of {@link createServer}: every config key plus the programmatic extras. */
export interface CreateServerOptions extends ServerOptions {
  /** Environment layer (default `process.env`; `{}` isolates the server from the host env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `false` disables the config file layer; a string names the file; absent = discovery. */
  readonly configFile?: false | string;
  /** Human output (banner, seed password); default the process streams. */
  readonly output?: {
    readonly stdout?: (line: string) => void;
    readonly stderr?: (line: string) => void;
  };
  /** Extra log sink. */
  readonly logger?: BrowserHiveLogSink;
  /** Host RAM in bytes for the `maxSessions` derivation (tests). */
  readonly hostMemory?: number;
}

/** A created (not yet listening) server. */
export interface BrowserHiveServer {
  /** Deep-frozen effective configuration. */
  readonly config: Readonly<ServerConfig>;
  /** Where every key came from. */
  readonly provenance: Provenance;
  /** `http://host:port` (the bound port after `listen()` when `port: 0`); `null` under stdio or before an ephemeral bind. */
  readonly url: string | null;
  /** Boots the server; resolves when `/health` is ready. Idempotent (the same promise). */
  listen(): Promise<void>;
  /** Graceful stop within `deadline` ms (default `shutdownTimeout`). Idempotent; safe after a failed `listen()`. */
  stop(deadline?: number | { readonly deadlineMs?: number }): Promise<void>;
}

/** Invalid configuration: the same problems and messages the CLI prints (exit 64, or 3 for policy refusals). */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly code: ConfigFailure['code'];
  readonly exitCode: ConfigFailure['exitCode'];
  readonly problems: ConfigFailure['problems'];

  constructor(failure: ConfigFailure) {
    super(failure.render());
    this.code = failure.code;
    this.exitCode = failure.exitCode;
    this.problems = failure.problems;
  }
}

const EXTRA_OPTIONS: ReadonlySet<string> = new Set([
  'env',
  'configFile',
  'output',
  'logger',
  'hostMemory',
]);

function isConfigKey(name: string): name is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(name);
}

/** Splits the options into config overrides and reports unknown keys the resolver would never see. */
function splitOptions(options: CreateServerOptions): ConfigOverrides {
  const overrides: Record<string, unknown> = {};
  const problems: Parameters<typeof configFailure>[0][number][] = [];
  for (const [name, value] of Object.entries(options)) {
    if (EXTRA_OPTIONS.has(name) || value === undefined) continue;
    if (isConfigKey(name)) {
      overrides[name] = value;
      continue;
    }
    const hint = suggestKey(name, 'json', CONFIG_KEYS);
    problems.push({
      code: 'CONFIG_UNKNOWN_KEY',
      source: 'cli',
      location: `options.${name}`,
      message: withSuggestion(`unknown option '${name}'.`, hint.suggestions),
      suggestions: hint.suggestions,
    });
  }
  if (problems.length > 0) throw new ConfigError(configFailure(problems));
  return overrides;
}

/** `OutputSinks` from the option (missing streams fall back to the process streams). */
function outputFrom(output: CreateServerOptions['output']): OutputSinks {
  const custom = output !== undefined;
  return {
    stdout: output?.stdout ?? ((line) => void process.stdout.write(`${line}\n`)),
    stderr: output?.stderr ?? ((line) => void process.stderr.write(`${line}\n`)),
    isTty: {
      stdout: !custom && process.stdout.isTTY === true,
      stderr: !custom && process.stderr.isTTY === true,
    },
  };
}

/**
 * Resolves and validates the configuration eagerly (throws {@link ConfigError}), then returns a
 * server whose `listen()` runs the composition root.
 *
 * @example
 * const server = await createServer({ port: 0, dataDir: '/tmp/bh', env: {}, configFile: false });
 * await server.listen();
 * await fetch(`${server.url}/health`);
 * await server.stop();
 */
export async function createServer(options: CreateServerOptions = {}): Promise<BrowserHiveServer> {
  const env = options.env ?? processEnv();
  const output = outputFrom(options.output);
  const host = buildHostEnvironment({
    env,
    isTty: output.isTty,
    ...(options.hostMemory !== undefined && { totalMemoryBytes: options.hostMemory }),
  });
  const overrides = splitOptions(options);
  const result = resolveConfig({
    argv: [],
    env,
    cwd: process.cwd(),
    host,
    fs: nodeConfigFs,
    overrides,
    knownLogModules: LOG_MODULES,
    ...(options.configFile !== undefined && { configFile: options.configFile }),
  });
  if (!result.ok) throw new ConfigError(result.error);
  const resolved = result.value;
  const { config } = resolved;

  let running: RunningServer | undefined;
  let listening: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const logger = options.logger;

  const listen = (): Promise<void> => {
    if (stopping !== undefined) return Promise.reject(new Error('server was stopped'));
    listening ??= bootServer({
      resolved,
      host,
      output,
      env,
      appVersion: VERSION,
      installProcessHandlers: false,
      ...(logger !== undefined && {
        logSink: {
          name: 'external',
          write: (record) => logger.write(record),
          flush: () => logger.flush?.(),
        },
      }),
    }).then((server) => {
      running = server;
    });
    return listening;
  };

  return {
    config,
    provenance: resolved.provenance,
    get url() {
      if (config.transport === 'stdio') return null;
      if (running !== undefined) return running.url;
      return config.port === 0 ? null : urlFor(config.host, config.port);
    },
    listen,
    stop(deadline) {
      stopping ??= (async () => {
        // A boot in flight finishes (or unwinds itself on failure) before the stop runs.
        await listening?.catch(() => undefined);
        const deadlineMs = typeof deadline === 'number' ? deadline : deadline?.deadlineMs;
        await running?.stop(deadlineMs);
      })();
      return stopping;
    },
  };
}
