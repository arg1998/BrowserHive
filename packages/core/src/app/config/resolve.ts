/** @module app/config/resolve — `resolveConfig`: collect → normalize → parse → merge → derive → validate → guard → freeze (spec 08 §6) */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  CONFIG_KEYS,
  type ConfigKey,
  type ExplicitKeys,
  formatShadowLine,
  isInsecureBind,
  isLoopbackHost,
  lookupKey,
  type Provenance,
  type ServerConfig,
  type ShadowLine,
  serverConfigSchemaFor,
} from '@browserhive/contracts/config';
import { err, ok, type Result } from '../../kernel/result.ts';
import type { HostEnvironment } from '../../ports/host-environment.ts';
import { tokenizeArgs } from './argv.ts';
import { osDefaultDataDir } from './data-dir.ts';
import {
  type ConfigFs,
  DATA_DIR_IN_DATA_DIR_MESSAGE,
  type DiscoveredConfigFile,
  discoverConfigFile,
} from './discover.ts';
import { type ConfigFailure, type ConfigProblem, configFailure } from './failure.ts';
import { keyKind } from './kinds.ts';
import {
  type CollectedLayer,
  type ConfigOverrides,
  collectCliLayer,
  collectEnvLayer,
  collectFileLayer,
  collectOtelLayer,
  collectOverridesLayer,
} from './layers.ts';
import { mergeLayers, type ParsedLayer } from './merge.ts';
import { type ParsedEntry, parseEntry } from './parse.ts';
import { isRegisteredSpelling } from './suggest.ts';

/** Inputs of {@link resolveConfig}. Everything is injected; nothing reads `process`. */
export interface ResolveConfigInput {
  /** Server flags only (the CLI strips the command word); positionals are usage errors. */
  readonly argv: readonly string[];
  /** The environment (`process.env` at the composition root, `{}` isolates). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Base directory for relative paths from env and CLI. */
  readonly cwd: string;
  /** Platform, home directory and RAM for the derived defaults. */
  readonly host: HostEnvironment;
  readonly fs: ConfigFs;
  /** `string`: explicit config file; `false`: no file layer at all; absent: discovery (spec 08 §3). */
  readonly configFile?: string | false;
  /** Programmatic API options (spec 08 §9): typed keys, provenance `cli`, above argv. */
  readonly overrides?: ConfigOverrides;
  /** Logger module registry for `logLevel` module names; unchecked when absent. */
  readonly knownLogModules?: readonly string[];
}

/** Startup diagnostics produced next to the config. */
export interface ConfigDiagnostics {
  /** One `config: …` line per key supplied by more than one source, in registry order. */
  readonly shadowLines: readonly ShadowLine[];
  /** Human warnings (non-fatal): insecure bind acknowledged, ignored OTEL variables. */
  readonly warnings: readonly string[];
}

/** The successful outcome of {@link resolveConfig}. */
export interface ResolvedConfigBundle {
  /** The validated configuration, deep-frozen. */
  readonly config: Readonly<ServerConfig>;
  readonly provenance: Provenance;
  readonly diagnostics: ConfigDiagnostics;
  /** Absolute path of the config file in use, if any. */
  readonly configFilePath: string | undefined;
  /** Keys supplied by env, file or CLI. */
  readonly explicitKeys: ExplicitKeys;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

function isBooleanFlag(name: string): boolean {
  const found = lookupKey('cli', `--${name}`);
  return found.kind === 'key' && keyKind(found.key) === 'boolean';
}

interface ParseOutcome {
  readonly layer: ParsedLayer;
  readonly problems: readonly ConfigProblem[];
}

function parseLayer(
  collected: CollectedLayer,
  options: { readonly cwd: string; readonly knownLogModules?: readonly string[] },
): ParseOutcome {
  const layer = new Map<ConfigKey, ParsedEntry>();
  const problems: ConfigProblem[] = [...collected.problems];
  for (const entry of collected.entries.values()) {
    const parsed = parseEntry(entry, options);
    if (parsed.ok) layer.set(entry.key, parsed.value);
    else problems.push(parsed.error);
  }
  return { layer, problems };
}

function firstValue(layers: readonly ParsedLayer[], key: ConfigKey): unknown {
  for (const layer of layers) {
    const entry = layer.get(key);
    if (entry !== undefined) return entry.value;
  }
  return undefined;
}

function explicitConfigPath(
  input: ResolveConfigInput,
  layers: readonly ParsedLayer[],
): { readonly path: string; readonly location: string } | undefined {
  if (typeof input.configFile === 'string') {
    const path = isAbsolute(input.configFile)
      ? input.configFile
      : resolvePath(input.cwd, input.configFile);
    return { path, location: 'options.configFile' };
  }
  for (const layer of layers) {
    const entry = layer.get('config');
    if (entry !== undefined && typeof entry.value === 'string') {
      return { path: entry.value, location: entry.location };
    }
  }
  return undefined;
}

function validationProblems(
  values: Readonly<Record<ConfigKey, unknown>>,
  explicit: ExplicitKeys,
): Result<ServerConfig, readonly ConfigProblem[]> {
  const ephemeralPort = values['port'] === 0;
  const candidate = ephemeralPort ? { ...values, port: 1 } : values;
  const parsed = serverConfigSchemaFor(explicit).safeParse(candidate);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue): ConfigProblem => {
        const key = issue.path.map(String)[0];
        const params: unknown = 'params' in issue ? issue.params : undefined;
        const code: unknown =
          typeof params === 'object' && params !== null && 'code' in params
            ? params.code
            : undefined;
        return {
          code: code === 'ADMIN_REQUIRES_HTTP' ? 'ADMIN_REQUIRES_HTTP' : 'CONFIG_INVALID',
          ...(key !== undefined && { key }),
          source: 'cross-field',
          location: key ?? 'config',
          message: issue.message,
        };
      }),
    );
  }
  return ok(ephemeralPort ? { ...parsed.data, port: 0 } : parsed.data);
}

/**
 * Resolve the effective configuration from the ladder `defaults < env < file < cli` (spec 08 §1)
 * with every fail-fast rule of §4. Pure: all problems of all sources are collected before failing.
 *
 * @returns The frozen config with provenance and diagnostics, or a {@link ConfigFailure}.
 */
export function resolveConfig(
  input: ResolveConfigInput,
): Result<ResolvedConfigBundle, ConfigFailure> {
  const parseOptions = {
    cwd: input.cwd,
    ...(input.knownLogModules !== undefined && { knownLogModules: input.knownLogModules }),
  };
  const problems: ConfigProblem[] = [];
  const warnings: string[] = [];

  // 1–3. Collect, normalize and parse env, OTEL, CLI and overrides.
  const tokens = tokenizeArgs(input.argv, {
    isBoolean: isBooleanFlag,
    known: (name) => isRegisteredSpelling('cli', `--${name}`),
  });
  const env = parseLayer(collectEnvLayer(input.env), parseOptions);
  const cli = parseLayer(collectCliLayer(tokens), parseOptions);
  const overrides = parseLayer(collectOverridesLayer(input.overrides ?? {}), parseOptions);
  problems.push(...env.problems, ...cli.problems, ...overrides.problems);
  const cliLayer: ParsedLayer = new Map([...cli.layer, ...overrides.layer]);

  // Pre-pass: dataDir from defaults, env and CLI only (spec 08 §3).
  const prePassDataDir = firstValue([cliLayer, env.layer], 'dataDir');
  const dataDir =
    typeof prePassDataDir === 'string' ? prePassDataDir : osDefaultDataDir(input.host);

  // File layer.
  let file: DiscoveredConfigFile | undefined;
  let fileLayer: ParsedLayer = new Map();
  if (input.configFile !== false) {
    const explicit = explicitConfigPath(input, [cliLayer, env.layer]);
    const discovered = discoverConfigFile({
      ...(explicit !== undefined && { explicit }),
      cwd: input.cwd,
      dataDir,
      fs: input.fs,
    });
    if (!discovered.ok) problems.push(discovered.error);
    else file = discovered.value;
  }
  if (file !== undefined) {
    const parsedFile = parseLayer(collectFileLayer(file.json, file.path), parseOptions);
    problems.push(...parsedFile.problems);
    fileLayer = parsedFile.layer;
    if (file.origin === 'dataDir' && fileLayer.has('dataDir')) {
      problems.push({
        code: 'CONFIG_USAGE',
        key: 'dataDir',
        source: 'file',
        location: `file:${file.path}#dataDir`,
        message: `config: ${DATA_DIR_IN_DATA_DIR_MESSAGE}`,
      });
    }
  }

  // OTEL sub-source: consulted below BROWSERHIVE_* env; parse failures only matter when otel is on.
  const otelOn = firstValue([cliLayer, fileLayer, env.layer], 'otel') === true;
  const otel = parseLayer(collectOtelLayer(input.env), parseOptions);
  if (otelOn) problems.push(...otel.problems);
  else warnings.push(...otel.problems.map((p) => `ignoring ${p.location}: ${p.message}`));

  if (problems.length > 0) return err(configFailure(problems));

  // 4. Merge with provenance; defaults and derived values.
  const merged = mergeLayers([cliLayer, fileLayer, env.layer, otel.layer], input.host);

  // 5. Validate (cross-field rules) and apply the policy guards.
  const validated = validationProblems(merged.values, merged.explicit);
  if (!validated.ok) return err(configFailure(validated.error));
  const config = validated.value;
  if (isInsecureBind(config)) {
    return err(
      configFailure([
        {
          code: 'INSECURE_BIND_REFUSED',
          key: 'host',
          source: 'policy',
          location: 'host',
          message: `Refusing to bind ${config.host} without authentication. Set auth=token, or set allowInsecureBind=true to accept the risk.`,
        },
      ]),
    );
  }
  if (config.transport === 'http' && !isLoopbackHost(config.host) && config.auth !== 'token') {
    warnings.push(
      `binding ${config.host} without authentication because allowInsecureBind=true; anyone who can reach this port controls the browsers.`,
    );
  }

  // 6. Freeze.
  const shadowLines: ShadowLine[] = CONFIG_KEYS.filter(
    (key) => merged.provenance[key].shadowed.length > 0,
  ).map((key) => ({
    key,
    text: formatShadowLine(merged.provenance[key], (value) => value.raw),
  }));
  return ok({
    config: deepFreeze(config),
    provenance: deepFreeze(merged.provenance),
    diagnostics: deepFreeze({ shadowLines, warnings }),
    configFilePath: file?.path,
    explicitKeys: merged.explicit,
  });
}
