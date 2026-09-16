/** @module cli/commands/common — helpers shared by commands: timestamps, byte sizes, `AppError` recognition and the data-dir lock refusal */
import { join } from 'node:path';
import { ERROR_REGISTRY, type ErrorCode, isErrorCode } from '@browserhive/contracts/errors';
import { formatBytes } from '@browserhive/core/kernel';
import type { CliDeps, CommandContext } from '../deps.ts';
import { EXIT, type ExitCode } from '../invocation.ts';

/** Database file name inside the data dir (D-24). */
export const DATABASE_FILE = 'browserhive.db';

/**
 * Path of the database in a data dir.
 *
 * @returns `<dataDir>/browserhive.db`.
 */
export function databasePath(dataDir: string): string {
  return join(dataDir, DATABASE_FILE);
}

/**
 * `2026-09-16 08:05Z` (UTC, minute precision), `—` for `null`.
 *
 * @returns The timestamp text.
 */
export function formatTimestamp(ms: number | null): string {
  if (ms === null) return '—';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/**
 * Human size (`18.4 MB`), decimal (SI) units.
 *
 * @returns The size text.
 */
export function size(bytes: number): string {
  return formatBytes(bytes);
}

/** The structural facts of a thrown `AppError` (duck-typed so a second module instance still matches). */
export interface AppErrorFacts {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint: string | undefined;
  readonly exitCode: number;
  readonly stack: string | undefined;
}

/**
 * Recognises an `AppError` by its registry code.
 *
 * @returns The facts, or `null` for any other value.
 */
export function appErrorFacts(value: unknown): AppErrorFacts | null {
  if (!(value instanceof Error) || !('code' in value)) return null;
  const code: unknown = value.code;
  if (typeof code !== 'string' || !isErrorCode(code)) return null;
  const spec = ERROR_REGISTRY[code];
  const publicMessage: unknown = 'publicMessage' in value ? value.publicMessage : undefined;
  return {
    code,
    message: typeof publicMessage === 'string' ? publicMessage : value.message,
    hint: spec.hint,
    exitCode: 'exitCode' in spec && typeof spec.exitCode === 'number' ? spec.exitCode : EXIT.fatal,
    stack: value.stack,
  };
}

/**
 * Refuses when a live process holds the data-dir lock (a running server).
 *
 * @returns `null` when free, otherwise the exit code after printing the refusal.
 */
export function refuseWhileLocked(
  context: CommandContext,
  dataDir: string,
  what: string,
  alternative?: string,
): ExitCode | null {
  const holder = context.deps.lock.read(dataDir);
  if (holder === null) return null;
  const owner = holder.owner === null ? 'BrowserHive' : `'${holder.owner}'`;
  context.out.diagnostic(
    `browserhive: [DATA_DIR_LOCKED] Refusing to ${what}: ${dataDir} is in use by ${owner} (pid ${holder.pid}).`,
  );
  context.out.diagnostic(
    `Stop the running server first${alternative === undefined ? '' : `, or ${alternative}`}.`,
  );
  return EXIT.policy;
}

/**
 * Whether the database file exists.
 *
 * @returns `true` when `<dataDir>/browserhive.db` is a file.
 */
export async function databaseExists(deps: CliDeps, dataDir: string): Promise<boolean> {
  const stat = await deps.fs.stat(databasePath(dataDir));
  return stat?.isFile === true;
}

/**
 * Runs `fn` with storage and always closes it.
 *
 * @returns What `fn` returns.
 */
export async function withStorage<T>(
  deps: CliDeps,
  input: Parameters<CliDeps['openStorage']>[0],
  fn: (storage: Awaited<ReturnType<CliDeps['openStorage']>>) => Promise<T>,
): Promise<T> {
  const storage = await deps.openStorage(input);
  try {
    return await fn(storage);
  } finally {
    await storage.close();
  }
}
