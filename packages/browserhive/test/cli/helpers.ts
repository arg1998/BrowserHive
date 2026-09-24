/** @module test/cli/helpers — fake `CliDeps` for the CLI suites: in-memory filesystem and config fs, scripted probes, fake storage, captured streams */
import { dirname } from 'node:path';
import type { Channel } from '@browserhive/contracts/enums';
import type { ConfigFs } from '@browserhive/core/config';
import type { FileStat, FileSystem } from '@browserhive/core/ports/file-system';
import type { HostEnvironment } from '@browserhive/core/ports/host-environment';
import type { ProcessRunner, ProcessRunResult } from '@browserhive/core/ports/process-runner';
import type {
  DetectedBrowser,
  SandboxEnvironment,
  SandboxProbeResult,
} from '@browserhive/core/server';
import type {
  BrowserInstall,
  CliDeps,
  CliStorage,
  DatabaseFileInfo,
  DatabaseStatus,
  HostProbes,
  LockHolder,
  MigrateReport,
  MigrationRef,
  ServeBootInput,
  ServeRunningServer,
  TokenRow,
} from '../../src/cli/deps.ts';
import { runCli } from '../../src/cli/run.ts';

export const DATA_DIR = '/home/me/.local/share/browserhive';
export const APPLICATION_ID = 0x42484956;

/** A fake host (Linux, 16 GiB). */
export function fakeHost(overrides: Partial<HostEnvironment> = {}): HostEnvironment {
  return {
    platform: 'linux',
    arch: 'x64',
    release: '6.8.0',
    homeDir: '/home/me',
    tmpDir: '/tmp',
    totalMemoryBytes: 16 * 1024 ** 3,
    cpuCount: 8,
    isTty: { stdout: false, stderr: false },
    env: {},
    ...overrides,
  };
}

interface Entry {
  kind: 'file' | 'dir';
  data: string;
  mode: number;
  mtimeMs: number;
}

/** In-memory filesystem implementing both `FileSystem` and `ConfigFs`. */
export class MemoryFs implements FileSystem {
  readonly entries = new Map<string, Entry>();
  readonly writes: string[] = [];

  constructor(files: Record<string, string> = {}) {
    for (const [path, data] of Object.entries(files)) this.put(path, data);
  }

  put(path: string, data: string, mode = 0o600): void {
    this.ensureDir(dirname(path));
    this.entries.set(path, { kind: 'file', data, mode, mtimeMs: 1_700_000_000_000 });
  }

  ensureDir(path: string, mode = 0o700): void {
    if (path === '/' || path === '.' || this.entries.has(path)) return;
    this.ensureDir(dirname(path));
    this.entries.set(path, { kind: 'dir', data: '', mode, mtimeMs: 0 });
  }

  async stat(path: string): Promise<FileStat | null> {
    const entry = this.entries.get(path);
    if (entry === undefined) return null;
    return {
      isFile: entry.kind === 'file',
      isDirectory: entry.kind === 'dir',
      sizeBytes: entry.kind === 'file' ? entry.data.length : 0,
      mtimeMs: entry.mtimeMs,
    };
  }

  async readdir(path: string): Promise<readonly string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map((key) => key.slice(prefix.length));
  }

  async unlink(path: string): Promise<void> {
    this.writes.push(`unlink ${path}`);
    this.entries.delete(path);
  }

  async rm(path: string): Promise<void> {
    this.writes.push(`rm ${path}`);
    for (const key of [...this.entries.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
    }
  }

  async mkdir(path: string, options?: { readonly mode?: number }): Promise<void> {
    this.writes.push(`mkdir ${path}`);
    this.ensureDir(path, options?.mode ?? 0o700);
  }

  async readFile(path: string): Promise<string> {
    const entry = this.entries.get(path);
    if (entry?.kind !== 'file') throw new Error(`ENOENT: ${path}`);
    return entry.data;
  }

  async writeFile(path: string, data: string, options?: { readonly mode?: number }): Promise<void> {
    this.writes.push(`write ${path}`);
    // Like the node adapter: the mode applies to a new file only.
    this.put(path, data, this.entries.get(path)?.mode ?? options?.mode ?? 0o644);
  }

  /** The synchronous `ConfigFs` view of the same tree. */
  configFs(): ConfigFs {
    return {
      readFile: (path) => {
        const entry = this.entries.get(path);
        if (entry?.kind !== 'file') throw new Error(`ENOENT: no such file ${path}`);
        return entry.data;
      },
      stat: (path) => {
        const entry = this.entries.get(path);
        return entry === undefined
          ? undefined
          : { isFile: entry.kind === 'file', mode: entry.mode };
      },
    };
  }
}

/** Mutable state behind {@link FakeStorage}. */
export interface StorageState {
  userVersion: number;
  minReaderVersion: number;
  applicationId: number;
  pending: MigrationRef[];
  tables: { table: string; rows: number }[];
  openSessions: number;
  tokens: TokenRow[];
  backups: string[];
  quickCheckOk: boolean;
  resets: number;
  opened: { readOnly: boolean; migrate: boolean; owner: string }[];
  closed: number;
}

/** A default storage state (schema v1, no pending migrations). */
export function storageState(overrides: Partial<StorageState> = {}): StorageState {
  return {
    userVersion: 1,
    minReaderVersion: 1,
    applicationId: APPLICATION_ID,
    pending: [],
    tables: [
      { table: 'sessions', rows: 3 },
      { table: 'tool_calls', rows: 120 },
    ],
    openSessions: 0,
    tokens: [],
    backups: [],
    quickCheckOk: true,
    resets: 0,
    opened: [],
    closed: 0,
    ...overrides,
  };
}

function fakeStorage(
  state: StorageState,
  fs: MemoryFs,
  dataDir: string,
  now: () => number,
): CliStorage {
  return {
    status: async (): Promise<DatabaseStatus> => ({
      path: `${dataDir}/browserhive.db`,
      exists: true,
      userVersion: state.userVersion,
      minReaderVersion: state.minReaderVersion,
      applicationId: state.applicationId,
      binarySchemaVersion: 1,
      pending: state.pending,
      sizeBytes: 4096,
      pageCount: 1,
      pageSize: 4096,
      lastBackup:
        state.backups.length === 0
          ? null
          : { path: state.backups.at(-1) ?? '', sizeBytes: 4096, mtimeMs: 1_700_000_000_000 },
      backupsCount: state.backups.length,
      quickCheck: { ok: state.quickCheckOk, messages: state.quickCheckOk ? [] : ['row 3 missing'] },
    }),
    pending: async () => state.pending,
    migrate: async (): Promise<MigrateReport> => {
      const applied = state.pending.map((m) => ({ ...m, durationMs: 3 }));
      const from = state.userVersion;
      state.userVersion = applied.at(-1)?.version ?? state.userVersion;
      state.pending = [];
      return {
        from,
        to: state.userVersion,
        applied,
        backupPath: applied.length > 0 ? `${dataDir}/backups/pre.db` : null,
      };
    },
    backup: async (out) => {
      const path = out ?? `${dataDir}/backups/browserhive-v${state.userVersion}-${now()}.db`;
      fs.put(path, 'SQLite format 3');
      state.backups.push(path);
      return path;
    },
    tableCounts: async () => state.tables,
    openSessionCount: async () => state.openSessions,
    resetPassword: async () => {
      state.resets += 1;
      const credentialsPath = `${dataDir}/admin/credentials.txt`;
      fs.put(credentialsPath, 'Kq7pass\n');
      return { password: 'Kq7-generated-password-24', credentialsPath };
    },
    listTokens: async () => state.tokens,
    createToken: async ({ principal, expiresInMs }) => {
      const row: TokenRow = {
        credentialId: `cred-${state.tokens.length + 1}`,
        publicPrefix: `pre${state.tokens.length + 1}xxxx`,
        ownerKind: 'agent',
        subject: principal,
        scopes: ['mcp:tools'],
        createdAt: now(),
        lastUsedAt: null,
        expiresAt: expiresInMs === null ? null : now() + expiresInMs,
      };
      state.tokens.push(row);
      return {
        credentialId: row.credentialId,
        principalId: principal,
        publicPrefix: row.publicPrefix,
        token: `bh_agent_${'A'.repeat(43)}`,
        expiresAt: row.expiresAt,
      };
    },
    revokeToken: async (credentialId) => {
      state.tokens = state.tokens.filter((row) => row.credentialId !== credentialId);
    },
    close: async () => {
      state.closed += 1;
    },
  };
}

/** Scripted probe answers. */
export interface ProbeState {
  bun: string;
  sqlite: string;
  playwright: { -readonly [K in keyof BrowserInstall]: BrowserInstall[K] };
  patchright: { -readonly [K in keyof BrowserInstall]: BrowserInstall[K] };
  portFree: boolean;
  bw: string | null;
  diskFree: number | null;
  modes: Record<string, number>;
  otlp: { ok: boolean; detail: string };
  /** Detected channels (bundled Chromium first). */
  browsers: DetectedBrowser[];
  /** Sandbox probe verdict per channel; missing channels answer `not-installed`. */
  sandbox: Partial<Record<Channel, SandboxProbeResult>>;
  environment: SandboxEnvironment;
  apparmorCovered: boolean | null;
  /** Channels whose sandbox was probed, in order. */
  probed: Channel[];
}

const NO_POLICIES = { location: null, names: [], blocking: [] };

/** A detected browser for the probe fakes. */
export function detected(
  channel: Channel,
  overrides: Partial<DetectedBrowser> = {},
): DetectedBrowser {
  const label = { chromium: 'Chrome for Testing', chrome: 'Google Chrome', edge: 'Microsoft Edge' }[
    channel
  ];
  const installed = overrides.installed ?? channel === 'chromium';
  return {
    channel,
    label,
    source: channel === 'chromium' ? 'bundled' : 'installed',
    installed,
    executablePath: installed
      ? channel === 'chromium'
        ? '/cache/chromium-1243/chrome'
        : channel === 'chrome'
          ? '/opt/google/chrome/chrome'
          : '/opt/microsoft/msedge/msedge'
      : null,
    version: installed ? (channel === 'chromium' ? '153.0.8010.12' : '154.0.8037.57') : null,
    policies: NO_POLICIES,
    ...overrides,
  };
}

/** A normal-user Linux host without restrictions. */
export function sandboxEnvironment(
  overrides: Partial<SandboxEnvironment> = {},
): SandboxEnvironment {
  return {
    platform: 'linux',
    distro: 'Ubuntu 24.04.1 LTS',
    root: false,
    container: false,
    apparmorRestrictsUserns: false,
    usernsCloneDisabled: false,
    userNamespacesDisabled: false,
    ...overrides,
  };
}

/** Default probe answers: everything healthy. */
export function probeState(overrides: Partial<ProbeState> = {}): ProbeState {
  return {
    bun: '1.4.2',
    sqlite: '3.53.2',
    playwright: {
      packageVersion: '1.63.0',
      executablePath: '/cache/chromium-1243/chrome',
      installed: true,
    },
    patchright: {
      packageVersion: '1.63.0',
      executablePath: '/cache/chromium-1243/chrome',
      installed: true,
    },
    portFree: true,
    bw: null,
    diskFree: 50 * 1000 ** 3,
    modes: {},
    otlp: { ok: true, detail: 'HTTP 405' },
    browsers: [detected('chromium'), detected('chrome'), detected('edge')],
    sandbox: { chromium: { state: 'works', version: '153.0.8010.12' } },
    environment: sandboxEnvironment(),
    apparmorCovered: null,
    probed: [],
    ...overrides,
  };
}

function fakeProbes(state: ProbeState): HostProbes {
  return {
    bunVersion: () => state.bun,
    sqliteVersion: async () => state.sqlite,
    playwright: async () => state.playwright,
    patchright: async () => state.patchright,
    portFree: async () => state.portFree,
    which: async () => state.bw,
    diskFreeBytes: async () => state.diskFree,
    pathMode: async (path) => state.modes[path] ?? 0o700,
    installCommand: (driver) => ({ command: '/usr/bin/bun', args: [`/pkg/${driver}/cli.js`] }),
    httpReachable: async () => state.otlp,
    browsers: async () => state.browsers,
    sandbox: async (channel) => {
      state.probed.push(channel);
      return state.sandbox[channel] ?? { state: 'not-installed' };
    },
    sandboxEnvironment: async () => state.environment,
    apparmorCovers: async () => state.apparmorCovered,
  };
}

/** Options of {@link cliHarness}. */
export interface HarnessOptions {
  argv: readonly string[];
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  fs?: MemoryFs;
  answers?: string[] | null;
  storage?: StorageState;
  probes?: ProbeState;
  lock?: LockHolder | null;
  run?: (command: string, args: readonly string[]) => ProcessRunResult | Promise<ProcessRunResult>;
  inspect?: DatabaseFileInfo | null;
  boot?: (input: ServeBootInput) => Promise<ServeRunningServer>;
  http?: CliDeps['http'];
  stdoutTty?: boolean;
  openError?: unknown;
  /** Replaces individual deps (real storage, real filesystem) after the fakes are built. */
  overrides?: Partial<CliDeps>;
}

/** Result of a harness run. */
export interface HarnessResult {
  code: number;
  stdout: string;
  stderr: string;
  prompts: string[];
  fs: MemoryFs;
  storage: StorageState;
  runs: { command: string; args: readonly string[] }[];
  locks: string[];
  boots: ServeBootInput[];
}

/**
 * Runs the CLI with fakes.
 *
 * @returns Captured output, exit code and the fakes' state.
 */
export async function cliHarness(options: HarnessOptions): Promise<HarnessResult> {
  const fs = options.fs ?? new MemoryFs(options.files ?? {});
  const storage = options.storage ?? storageState();
  const probes = options.probes ?? probeState();
  const prompts: string[] = [];
  const answers = options.answers === undefined ? null : options.answers;
  const runs: HarnessResult['runs'] = [];
  const locks: string[] = [];
  const boots: ServeBootInput[] = [];
  let stdout = '';
  let stderr = '';
  let clock = 1_758_000_000_000;
  const runner: ProcessRunner = {
    run: async (command, args) => {
      runs.push({ command, args });
      if (options.run !== undefined) return options.run(command, args);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
  };
  const env = options.env ?? {};
  const deps: CliDeps = {
    argv: options.argv,
    env,
    cwd: '/work',
    host: fakeHost({ env }),
    configFs: fs.configFs(),
    fs,
    streams: {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
      isTty: { stdin: answers !== null, stdout: options.stdoutTty ?? false, stderr: false },
      columns: undefined,
    },
    prompt:
      answers === null
        ? null
        : async (question) => {
            prompts.push(question);
            return answers.shift() ?? '';
          },
    clock: { now: () => (clock += 1000) },
    appVersion: '0.1.0',
    logModules: ['sessions', 'http', 'config'],
    runner,
    bootServer: async (input) => {
      boots.push(input);
      if (options.boot !== undefined) return options.boot(input);
      return {
        url: 'http://127.0.0.1:9876',
        transport: 'http',
        stop: async () => undefined,
        done: Promise.resolve(0),
      };
    },
    openStorage: async (input) => {
      storage.opened.push({ readOnly: input.readOnly, migrate: input.migrate, owner: input.owner });
      if (options.openError !== undefined) throw options.openError;
      return fakeStorage(storage, fs, input.dataDir, () => clock);
    },
    inspectDatabase: async () =>
      options.inspect === undefined
        ? { applicationId: APPLICATION_ID, userVersion: 1, minReaderVersion: 1 }
        : options.inspect,
    copyFile: async (from, to) => {
      fs.put(to, await fs.readFile(from));
    },
    lock: {
      read: () => options.lock ?? null,
      acquire: (dataDir, owner) => {
        locks.push(`${owner}@${dataDir}`);
        return { release: () => locks.push(`release ${owner}`) };
      },
    },
    probes: fakeProbes(probes),
    http:
      options.http ??
      (async () => {
        throw new Error('network disabled in tests');
      }),
    schemaVersion: 1,
    applicationId: APPLICATION_ID,
  };
  const code = await runCli({ ...deps, ...options.overrides });
  return { code, stdout, stderr, prompts, fs, storage, runs, locks, boots };
}
