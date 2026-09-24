/** @module cli/commands/doctor-checks — the individual `browserhive doctor` checks, each returning `{ check, status, detail }` from injected probes (spec 08 §7.1) */
import { join } from 'node:path';
import {
  CONFIG_KEYS,
  formatRefNames,
  type RefToken,
  type ServerConfig,
  scanRefs,
  type ValueRef,
} from '@browserhive/contracts/config';
import {
  deriveMaxSessions,
  isJsonObject,
  parseJson,
  type ResolvedConfigBundle,
} from '@browserhive/core/config';
import type { CliDeps } from '../deps.ts';
import { databasePath, formatTimestamp, size } from './common.ts';

/** Outcome of one check. */
export type CheckStatus = 'ok' | 'warn' | 'fail';

/** One doctor row (also the `--json` element). */
export interface CheckResult {
  readonly check: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** Minimum Bun version (D-01). */
export const MIN_BUN = '1.4.0';
/** Free-disk warning threshold. */
export const LOW_DISK_BYTES = 1024 ** 3;
/** OTLP reachability timeout (spec 08 §7.1). */
export const OTLP_TIMEOUT_MS = 2000;

function result(check: string, status: CheckStatus, detail: string): CheckResult {
  return { check, status, detail };
}

/**
 * Compares dotted numeric versions (`1.4.2` vs `1.4.0`); pre-release suffixes are ignored.
 *
 * @returns Negative, zero or positive like `localeCompare`.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .split(/[-+]/)[0]
      ?.split('.')
      .map((n) => Number.parseInt(n, 10) || 0) ?? [];
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Bun ≥ 1.4. */
export function checkBun(deps: CliDeps): CheckResult {
  const version = deps.probes.bunVersion();
  return compareVersions(version, MIN_BUN) >= 0
    ? result('bun', 'ok', `bun ${version}`)
    : result('bun', 'fail', `bun ${version}; BrowserHive needs bun >= ${MIN_BUN}`);
}

/** The resolver ran clean (or its first problems). */
export function checkConfig(
  resolution:
    | { readonly ok: true; readonly value: ResolvedConfigBundle }
    | { readonly ok: false; readonly error: { render(): string } },
): CheckResult {
  if (!resolution.ok) {
    const lines = resolution.error.render().split('\n');
    const first = (lines[0] ?? '').replace(/^browserhive: /, '');
    const more =
      lines.length > 1 ? ` (+${lines.length - 1} more; run 'browserhive config validate')` : '';
    return result('config', 'fail', `${first}${more}`);
  }
  const bundle = resolution.value;
  const file = bundle.configFilePath ?? 'no config file';
  const shadowed = bundle.diagnostics.shadowLines.length;
  const warnings = bundle.diagnostics.warnings;
  if (warnings.length > 0) return result('config', 'warn', `${file}; ${warnings[0]}`);
  const fromRefs = CONFIG_KEYS.filter((key) => bundle.provenance[key].refs !== undefined).length;
  return result(
    'config',
    'ok',
    `valid · ${file}${shadowed > 0 ? ` · ${shadowed} shadowed` : ''}${fromRefs > 0 ? ` · ${fromRefs} from references` : ''}`,
  );
}

/**
 * One warning per reference that fell back to its `:-` default in an effective value (spec 08
 * §7.1): usually a variable someone meant to set. The default's text is never shown.
 *
 * @returns The rows, in registry order (none when resolution failed).
 */
export function checkReferenceDefaults(
  resolution: { readonly ok: true; readonly value: ResolvedConfigBundle } | { readonly ok: false },
): readonly CheckResult[] {
  if (!resolution.ok) return [];
  const rows: CheckResult[] = [];
  for (const key of CONFIG_KEYS) {
    const names = new Set<string>();
    for (const ref of resolution.value.provenance[key].refs ?? []) {
      if (ref.from !== 'default' || names.has(ref.ref)) continue;
      names.add(ref.ref);
      rows.push(
        result(
          'reference',
          'warn',
          `${key}: ${ref.ref} is not set (or empty), so the config file's default is used`,
        ),
      );
    }
  }
  return rows;
}

/** Chromium for Playwright and, unless `stealthDriver=playwright`, for Patchright. */
export async function checkBrowsers(
  deps: CliDeps,
  stealthDriver: ServerConfig['stealthDriver'],
): Promise<readonly CheckResult[]> {
  const rows: CheckResult[] = [];
  const playwright = await deps.probes.playwright();
  if (playwright.packageVersion === null) {
    rows.push(
      result(
        'chromium (playwright)',
        'fail',
        'playwright package not found; reinstall browserhive',
      ),
    );
  } else if (playwright.installed) {
    rows.push(
      result(
        'chromium (playwright)',
        'ok',
        `playwright ${playwright.packageVersion} · ${playwright.executablePath ?? 'installed'}`,
      ),
    );
  } else {
    rows.push(
      result(
        'chromium (playwright)',
        'fail',
        `not installed${playwright.executablePath === null ? '' : ` at ${playwright.executablePath}`}; run 'browserhive init'`,
      ),
    );
  }
  if (stealthDriver === 'playwright') return rows;
  const patchright = await deps.probes.patchright();
  const severity: CheckStatus = stealthDriver === 'patchright' ? 'fail' : 'warn';
  if (patchright.packageVersion === null) {
    rows.push(
      result(
        'chromium (patchright)',
        severity,
        stealthDriver === 'patchright'
          ? 'stealthDriver=patchright but the patchright package is not installed'
          : 'patchright not installed (optional); stealth sessions use Playwright',
      ),
    );
  } else if (patchright.installed) {
    rows.push(
      result(
        'chromium (patchright)',
        'ok',
        `patchright ${patchright.packageVersion} · ${patchright.executablePath ?? 'installed'}`,
      ),
    );
  } else {
    rows.push(
      result(
        'chromium (patchright)',
        severity,
        `patchright ${patchright.packageVersion}: Chromium not installed; run 'browserhive init'`,
      ),
    );
  }
  return rows;
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/** Data dir exists, is owner-only, has free disk. */
export async function checkDataDir(deps: CliDeps, dataDir: string): Promise<CheckResult> {
  const stat = await deps.fs.stat(dataDir);
  if (stat === null) {
    return result('data dir', 'warn', `${dataDir} does not exist; run 'browserhive init'`);
  }
  if (!stat.isDirectory) return result('data dir', 'fail', `${dataDir} is not a directory`);
  const mode = await deps.probes.pathMode(dataDir);
  const free = await deps.probes.diskFreeBytes(dataDir);
  const freeText = free === null ? 'free space unknown' : `${size(free)} free`;
  if (mode !== null && (mode & 0o077) !== 0) {
    return result(
      'data dir',
      'warn',
      `${dataDir} has mode ${octal(mode)}; run 'chmod 700 ${dataDir}'`,
    );
  }
  if (free !== null && free < LOW_DISK_BYTES) {
    return result('data dir', 'warn', `${dataDir} · only ${freeText}`);
  }
  return result(
    'data dir',
    'ok',
    `${dataDir} · ${mode === null ? '' : `${octal(mode)} · `}${freeText}`,
  );
}

/** The resolved host:port can be bound. */
export async function checkPort(
  deps: CliDeps,
  config: ServerConfig,
  dataDir: string,
): Promise<CheckResult> {
  if (config.transport === 'stdio') return result('port', 'ok', 'stdio transport (no listener)');
  const where = `${config.host}:${config.port}`;
  if (await deps.probes.portFree(config.host, config.port))
    return result('port', 'ok', `${where} is free`);
  const holder = deps.lock.read(dataDir);
  if (holder !== null) {
    return result(
      'port',
      'warn',
      `${where} is in use; a BrowserHive server (pid ${holder.pid}) is running on this data dir`,
    );
  }
  return result('port', 'fail', `${where} is in use by another process; pick another with --port`);
}

/** `bw` on PATH when `vault=bitwarden`. */
export async function checkVault(deps: CliDeps, config: ServerConfig): Promise<CheckResult> {
  if (config.vault !== 'bitwarden') return result('vault', 'ok', 'vault off');
  const bw = await deps.probes.which('bw');
  return bw === null
    ? result('vault', 'fail', "vault=bitwarden but the 'bw' CLI is not on PATH")
    : result('vault', 'ok', `bw at ${bw}`);
}

/**
 * An `events.db` in the data dir: not part of the data-dir layout (D-24), so BrowserHive never reads
 * it. Warned about so the operator knows that data is not in use rather than assuming it is.
 */
export async function checkUnrecognisedDataFiles(
  deps: CliDeps,
  dataDir: string,
): Promise<CheckResult> {
  const unrecognised = await deps.fs.stat(join(dataDir, 'events.db'));
  return unrecognised === null
    ? result('unrecognised data files', 'ok', 'none')
    : result(
        'unrecognised data files',
        'warn',
        "unrecognised data file 'events.db' found; BrowserHive does not read or migrate it",
      );
}

/** Database opens; versions, pending migrations, last backup, quick check. */
export async function checkDatabase(deps: CliDeps, dataDir: string): Promise<CheckResult> {
  const path = databasePath(dataDir);
  if ((await deps.fs.stat(path)) === null) {
    return result('database', 'warn', "not created yet; run 'browserhive init'");
  }
  let status: Awaited<ReturnType<Awaited<ReturnType<CliDeps['openStorage']>>['status']>>;
  try {
    const storage = await deps.openStorage({
      dataDir,
      readOnly: true,
      migrate: false,
      owner: 'doctor',
    });
    try {
      status = await storage.status();
    } finally {
      await storage.close();
    }
  } catch (err) {
    return result(
      'database',
      'fail',
      `cannot open ${path}: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
  const backup =
    status.lastBackup === null
      ? 'no backup'
      : `last backup ${formatTimestamp(status.lastBackup.mtimeMs)}`;
  const summary = `v${status.userVersion} (min reader ${status.minReaderVersion}) · ${status.pending.length} pending · ${size(status.sizeBytes)} · ${backup}`;
  if (status.applicationId !== deps.applicationId) {
    return result('database', 'fail', `${path} is not a BrowserHive database`);
  }
  if (status.minReaderVersion > deps.schemaVersion) {
    return result(
      'database',
      'fail',
      `${summary}; newer than this binary (v${deps.schemaVersion}); upgrade or 'browserhive db restore <backup>'`,
    );
  }
  if (!status.quickCheck.ok) {
    return result(
      'database',
      'fail',
      `${summary}; quick_check: ${status.quickCheck.messages[0] ?? 'failed'}`,
    );
  }
  if (status.pending.length > 0) {
    return result(
      'database',
      'warn',
      `${summary}; migrations apply on next start ('browserhive db migrate')`,
    );
  }
  return result('database', 'ok', summary);
}

/** OTLP endpoint answers a HEAD within 2 s (warning only). */
export async function checkOtel(deps: CliDeps, config: ServerConfig): Promise<CheckResult> {
  if (!config.otel) return result('otel', 'ok', 'telemetry off');
  const probe = await deps.probes.httpReachable(config.otelEndpoint, OTLP_TIMEOUT_MS);
  return probe.ok
    ? result('otel', 'ok', `${config.otelEndpoint} reachable (${probe.detail})`)
    : result('otel', 'warn', `${config.otelEndpoint} unreachable: ${probe.detail}`);
}

/** `maxSessions` against the RAM this process may use (host RAM capped by any cgroup limit). */
export function checkCapacity(deps: CliDeps, config: ServerConfig): CheckResult {
  const ramGib = deps.host.totalMemoryBytes / 1024 ** 3;
  const ram = `${ramGib.toFixed(1)} GiB RAM`;
  const suggested = deriveMaxSessions(deps.host.totalMemoryBytes);
  if (config.maxSessions === 'unbounded') {
    return result(
      'max sessions',
      'warn',
      `unbounded with ${ram}; about ${suggested} fit (≈1.5 GiB each)`,
    );
  }
  if (config.maxSessions > suggested) {
    return result(
      'max sessions',
      'warn',
      `${config.maxSessions} with ${ram}; about ${suggested} fit (≈1.5 GiB each)`,
    );
  }
  return result('max sessions', 'ok', `${config.maxSessions} · ${ram}`);
}

/** Splits the tokens of one list value into items at literal commas (a reference is never split). */
function listItems(tokens: readonly RefToken[]): RefToken[][] {
  const items: RefToken[][] = [[]];
  for (const token of tokens) {
    if (token.kind !== 'literal') {
      items.at(-1)?.push(token);
      continue;
    }
    token.text.split(',').forEach((part, index) => {
      if (index > 0) items.push([]);
      if (part !== '') items.at(-1)?.push({ kind: 'literal', text: part });
    });
  }
  return items;
}

/**
 * Whether one `name:token` item takes its token only from references: the part after the first
 * literal `:` (or the whole item) holds at least one reference, no other text, and no default
 * (a default would be a token written in the file).
 */
function tokenIsReference(item: readonly RefToken[]): boolean {
  const colonAt = item.findIndex((token) => token.kind === 'literal' && token.text.includes(':'));
  const colonToken = item[colonAt];
  const tokenPart: readonly RefToken[] =
    colonToken === undefined
      ? item
      : [
          { kind: 'literal', text: colonToken.text.slice(colonToken.text.indexOf(':') + 1) },
          ...item.slice(colonAt + 1),
        ];
  let refs = 0;
  for (const token of tokenPart) {
    if (token.kind === 'literal') {
      if (token.text.trim() !== '') return false;
    } else if (token.kind === 'ref' && (token.fallback ?? '') === '') {
      refs += 1;
    } else {
      return false;
    }
  }
  return refs > 0;
}

/**
 * Whether the config file's `authTokens` value holds no token itself: every item's token is a
 * reference (`"ci:{env:CI_TOKEN}"`, `"{env:BH_TOKENS}"`, spec 08 §3.1).
 *
 * @returns `true` only when that can be shown from the file's text.
 */
export function authTokensAreReferences(raw: unknown): boolean {
  const items =
    typeof raw === 'string'
      ? listItems(scanRefs(raw))
      : Array.isArray(raw)
        ? raw.map((item) => (typeof item === 'string' ? [...scanRefs(item)] : null))
        : null;
  if (items === null || items.length === 0) return false;
  return items.every((item) => item !== null && tokenIsReference(item));
}

function fileAuthTokens(deps: CliDeps, path: string): unknown {
  try {
    const parsed = parseJson(deps.configFs.readFile(path));
    return parsed.ok && isJsonObject(parsed.value) ? parsed.value['authTokens'] : undefined;
  } catch {
    return undefined;
  }
}

/** `authTokens` supplied by a config file readable by others, unless the file only references them. */
export function checkSecretsFile(deps: CliDeps, bundle: ResolvedConfigBundle): CheckResult {
  const path = bundle.configFilePath;
  const tokens = bundle.provenance.authTokens;
  const fromFile = tokens.source === 'file' || tokens.shadowed.some((s) => s.source === 'file');
  if (path === undefined || !fromFile)
    return result('secrets', 'ok', 'no secrets in a config file');
  if (authTokensAreReferences(fileAuthTokens(deps, path))) {
    const refs: readonly ValueRef[] =
      tokens.source === 'file'
        ? (tokens.refs ?? [])
        : (tokens.shadowed.find((s) => s.source === 'file')?.refs ?? []);
    return result(
      'secrets',
      'ok',
      `authTokens in ${path} come from ${formatRefNames(refs)}; the file holds no token`,
    );
  }
  const mode = deps.configFs.stat(path)?.mode;
  if (mode !== undefined && (mode & 0o077) !== 0) {
    return result(
      'secrets',
      'warn',
      `authTokens in ${path} with mode ${octal(mode)}; run 'chmod 600 ${path}'`,
    );
  }
  return result('secrets', 'ok', `authTokens in ${path} (owner-only)`);
}
