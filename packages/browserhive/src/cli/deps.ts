/** @module cli/deps — `CliDeps`: every effect the CLI performs, injected (process facts, filesystem, child processes, storage, server boot, probes) so the suites never touch the real host */
import type { ConfigFs, ResolvedConfigBundle } from '@browserhive/core/config';
import type { FileSystem } from '@browserhive/core/ports/file-system';
import type { HostEnvironment } from '@browserhive/core/ports/host-environment';
import type { ProcessRunner } from '@browserhive/core/ports/process-runner';
import type { CliOutputSinks, Output } from './output/output.ts';
import type { Prompter } from './output/process-io.ts';

/** Structural `BootInput` of the composition seam (the fields the CLI provides). */
export interface ServeBootInput {
  readonly resolved: ResolvedConfigBundle;
  readonly host: HostEnvironment;
  readonly output: CliOutputSinks;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appVersion: string;
  readonly installProcessHandlers: boolean;
}

/** Structural `RunningServer` of the composition seam. */
export interface ServeRunningServer {
  readonly url: string | null;
  readonly transport: 'http' | 'stdio';
  stop(deadlineMs?: number): Promise<void>;
  readonly done: Promise<number>;
}

/** One pending or applied migration. */
export interface MigrationRef {
  readonly version: number;
  readonly name: string;
}

/** `db status` facts. */
export interface DatabaseStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly userVersion: number;
  readonly minReaderVersion: number;
  readonly applicationId: number;
  /** Head schema version of this binary (`SCHEMA_VERSION`). */
  readonly binarySchemaVersion: number;
  readonly pending: readonly MigrationRef[];
  readonly sizeBytes: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly lastBackup: {
    readonly path: string;
    readonly sizeBytes: number;
    readonly mtimeMs: number;
  } | null;
  readonly backupsCount: number;
  readonly quickCheck: { readonly ok: boolean; readonly messages: readonly string[] };
}

/** Outcome of `db migrate`. */
export interface MigrateReport {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly (MigrationRef & { readonly durationMs: number })[];
  readonly backupPath: string | null;
}

/** One API token row (the secret is never listed). */
export interface TokenRow {
  readonly credentialId: string;
  readonly publicPrefix: string;
  readonly ownerKind: 'agent' | 'operator';
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
}

/** A freshly issued token; `token` is the plaintext, shown exactly once. */
export interface IssuedToken {
  readonly credentialId: string;
  readonly principalId: string;
  readonly publicPrefix: string;
  readonly token: string;
  readonly expiresAt: number | null;
}

/** Database access for `db`, `admin` and `purge` (built on `openStorageForCli`). */
export interface CliStorage {
  status(): Promise<DatabaseStatus>;
  /** Migrations this binary would apply. */
  pending(): Promise<readonly MigrationRef[]>;
  /**
   * Applies pending migrations and reports them. A writable `migrate: true` open already migrated
   * (with the pre-migration backup); the report then covers what that open applied.
   */
  migrate(): Promise<MigrateReport>;
  /** `VACUUM INTO` `out` (or a timestamped file under `backups/`); returns the path written. */
  backup(out: string | null): Promise<string>;
  /** Row counts per table (read-only, never migrates). */
  tableCounts(): Promise<readonly { readonly table: string; readonly rows: number }[]>;
  /** Sessions still marked open (not closed). */
  openSessionCount(): Promise<number>;
  resetPassword(): Promise<{ readonly password: string; readonly credentialsPath: string }>;
  listTokens(): Promise<readonly TokenRow[]>;
  createToken(input: {
    readonly principal: string;
    readonly expiresInMs: number | null;
  }): Promise<IssuedToken>;
  /** Revokes one token (credential id) and returns nothing. */
  revokeToken(credentialId: string): Promise<void>;
  close(): Promise<void>;
}

/** Options for opening storage. */
export interface OpenStorageInput {
  readonly dataDir: string;
  readonly readOnly: boolean;
  readonly migrate: boolean;
  /** Command name recorded in the data-dir lock (`db migrate`). */
  readonly owner: string;
}

/** Header facts of a SQLite file (restore verification). */
export interface DatabaseFileInfo {
  readonly applicationId: number;
  readonly userVersion: number;
  readonly minReaderVersion: number;
}

/** Lock holder of a data directory. */
export interface LockHolder {
  readonly pid: number;
  readonly owner: string | null;
  readonly startedAt: number | null;
}

/** A Chromium install as seen by one driver package. */
export interface BrowserInstall {
  /** Package version (`1.63.0`), `null` when the package is not installed. */
  readonly packageVersion: string | null;
  /** Expected executable path, `null` when unknown. */
  readonly executablePath: string | null;
  readonly installed: boolean;
}

/** Host probes used by `doctor`, `init` and `version`. */
export interface HostProbes {
  bunVersion(): string;
  /** `select sqlite_version()` (needs a connection, hence async). */
  sqliteVersion(): Promise<string>;
  playwright(): Promise<BrowserInstall>;
  patchright(): Promise<BrowserInstall>;
  /** Whether `host:port` can be bound right now. */
  portFree(host: string, port: number): Promise<boolean>;
  /** Absolute path of `command` on PATH, or `null`. */
  which(command: string): Promise<string | null>;
  /** Free bytes on the filesystem holding `path` (or its nearest existing parent). */
  diskFreeBytes(path: string): Promise<number | null>;
  /** Permission bits of `path` (`0o700`), or `null` when missing. */
  pathMode(path: string): Promise<number | null>;
  /**
   * How to run `<driver> install chromium` with the driver's own CLI (`bun <pkg>/cli.js`), or
   * `null` when the package cannot be resolved.
   */
  installCommand(
    driver: 'playwright' | 'patchright',
  ): { readonly command: string; readonly args: readonly string[] } | null;
  /** HEAD request with a timeout; `ok` means any HTTP response arrived. */
  httpReachable(
    url: string,
    timeoutMs: number,
  ): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

/** Minimal HTTP client for `admin tokens --url`. */
export type HttpFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<{ readonly status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Everything a CLI run needs. */
export interface CliDeps {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly host: HostEnvironment;
  readonly configFs: ConfigFs;
  readonly fs: FileSystem;
  readonly streams: {
    readonly stdout: (chunk: string) => void;
    readonly stderr: (chunk: string) => void;
    readonly isTty: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean };
    readonly columns: number | undefined;
  };
  /** Interactive prompt, `null` when stdin is not a terminal. */
  readonly prompt: Prompter | null;
  readonly clock: { now(): number };
  readonly appVersion: string;
  readonly logModules: readonly string[];
  readonly runner: ProcessRunner;
  bootServer(input: ServeBootInput): Promise<ServeRunningServer>;
  openStorage(input: OpenStorageInput): Promise<CliStorage>;
  inspectDatabase(path: string): Promise<DatabaseFileInfo | null>;
  /** Copies a file byte-for-byte (restore). */
  copyFile(from: string, to: string): Promise<void>;
  readonly lock: {
    /** The live holder of the data-dir lock, `null` when free or stale. */
    read(dataDir: string): LockHolder | null;
    /** Takes the lock for a maintenance command; throws `DATA_DIR_LOCKED` when held. */
    acquire(dataDir: string, owner: string): { release(): void };
  };
  readonly probes: HostProbes;
  readonly http: HttpFetch;
  /** Head schema version of this binary. */
  readonly schemaVersion: number;
  /** SQLite `application_id` BrowserHive stamps (`0x42484956`). */
  readonly applicationId: number;
}

/** What a command runner receives: the deps plus the output built for this run. */
export interface CommandContext {
  readonly deps: CliDeps;
  readonly out: Output;
}
