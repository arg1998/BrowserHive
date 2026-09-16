/** @module cli/commands/doctor-checks — the individual `browserhive doctor` checks, each returning `{ check, status, detail }` from injected probes (spec 08 §7.1) */
import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import { deriveMaxSessions, type ResolvedConfigBundle } from '@browserhive/core/config';
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
  return result('config', 'ok', `valid · ${file}${shadowed > 0 ? ` · ${shadowed} shadowed` : ''}`);
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

/** `maxSessions` against host RAM. */
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

/** `authTokens` supplied by a config file readable by others. */
export function checkSecretsFile(deps: CliDeps, bundle: ResolvedConfigBundle): CheckResult {
  const path = bundle.configFilePath;
  const fromFile =
    bundle.provenance.authTokens.source === 'file' ||
    bundle.provenance.authTokens.shadowed.some((s) => s.source === 'file');
  if (path === undefined || !fromFile)
    return result('secrets', 'ok', 'no secrets in a config file');
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
