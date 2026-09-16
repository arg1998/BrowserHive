/** @module infra/vault-backends/bitwarden/bitwarden-backend — the `bw` CLI adapter: minimal child env, `--` before positionals, per-call timeout, typed error mapping, secrets wrapped. */

import type { z } from 'zod';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { type Secret, secret } from '../../../kernel/secret.ts';
import type { Clock } from '../../../ports/clock.ts';
import type { HostEnvironment } from '../../../ports/host-environment.ts';
import type { Logger } from '../../../ports/logger.ts';
import { type ProcessRunner, ProcessSpawnError } from '../../../ports/process-runner.ts';
import type {
  VaultBackend,
  VaultBackendCapabilities,
  VaultEntry,
  VaultEntryQuery,
  VaultEntryRef,
  VaultEntrySummary,
  VaultGroup,
  VaultStatus,
  VaultSyncResult,
  VaultUnlockInput,
} from '../../../ports/vault-backend.ts';
import { BwFolderList, BwItem, BwItemList, BwStatus, loginUris, normGroupId } from './schemas.ts';

/** Default per-call ceiling for one `bw` invocation. */
export const BW_TIMEOUT_MS = 30_000;
/** Name of the ungrouped bucket, as `bw` reports it. */
export const NO_FOLDER_NAME = 'No Folder';
const BACKEND = 'bitwarden';

/** Constructor dependencies of {@link BitwardenBackend}. */
export interface BitwardenBackendDeps {
  readonly runner: ProcessRunner;
  /** Source of `PATH`, `HOME` and an optional pre-exported `BW_SESSION`. */
  readonly host: HostEnvironment;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Path to the `bw` binary; default `'bw'` (resolved on the child's `PATH`). */
  readonly binary?: string;
  /** Per-call timeout; default {@link BW_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Capabilities of the `bw` backend. */
export const BITWARDEN_CAPABILITIES: VaultBackendCapabilities = {
  unlock: 'token',
  grouping: true,
  writable: false,
  totp: true,
  sync: true,
};

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `bw` as a subprocess. BrowserHive never asks for the master password: the operator runs
 * `bw unlock --raw` themselves and either exports `BW_SESSION` before start or pastes the token on
 * the dashboard. The token is the only secret retained, in a `Secret` field; it reaches child
 * processes only through `BW_SESSION` in a minimal env (`PATH`, `HOME`, `BW_SESSION`).
 * Nothing from stdout/stderr is ever logged.
 */
export class BitwardenBackend implements VaultBackend {
  readonly kind = 'bitwarden' as const;
  readonly capabilities = BITWARDEN_CAPABILITIES;
  readonly unlockHint =
    'Run bw unlock --raw in a terminal where you are logged in to bw, then paste the session token it prints.';

  private readonly deps: BitwardenBackendDeps;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private session: Secret<string> | null;

  constructor(deps: BitwardenBackendDeps) {
    this.deps = deps;
    this.binary = deps.binary ?? 'bw';
    this.timeoutMs = deps.timeoutMs ?? BW_TIMEOUT_MS;
    this.log = deps.logger.child({ module: 'vault.bitwarden' });
    const initial = deps.host.env['BW_SESSION'];
    this.session = initial !== undefined && initial.length > 0 ? secret(initial) : null;
  }

  async status(signal?: AbortSignal): Promise<VaultStatus> {
    let unlocked = false;
    if (this.session !== null) {
      try {
        const parsed = await this.runJson(['status'], BwStatus, signal);
        unlocked = parsed.status === 'unlocked';
      } catch (err) {
        this.log.debug('bw status failed', { vault: true, err });
      }
    }
    return {
      unlocked,
      unlock: { required: !unlocked, mode: 'token', hint: this.unlockHint },
      checkedAt: this.deps.clock.now(),
    };
  }

  /**
   * Adopts a pasted `BW_SESSION` token (surrounding whitespace dropped) and keeps it only when
   * `bw status` confirms it. A passphrase is refused: the master password never reaches BrowserHive.
   * @throws `VALIDATION_FAILED` for a passphrase, `VAULT_UNLOCK_FAILED` for a rejected token
   */
  async unlock(input: VaultUnlockInput, signal?: AbortSignal): Promise<void> {
    if (input.mode !== 'token') {
      throw new AppError('VALIDATION_FAILED', {
        issues: [
          { path: 'token', message: 'bitwarden unlocks with a session token', code: 'custom' },
        ],
      });
    }
    const token = input.token.reveal().trim();
    if (token.length === 0) throw new AppError('VAULT_UNLOCK_FAILED', { mode: 'token' });
    const previous = this.session;
    this.session = secret(token);
    const status = await this.status(signal);
    if (!status.unlocked) {
      this.session = previous;
      throw new AppError('VAULT_UNLOCK_FAILED', { mode: 'token' });
    }
    this.log.info('vault unlocked', { vault: true, backend: BACKEND });
  }

  lock(): void {
    this.session = null;
  }

  async sync(signal?: AbortSignal): Promise<VaultSyncResult> {
    this.requireSession();
    await this.runOk(['sync'], signal);
    const [items, groups] = await Promise.all([
      this.listEntries({}, signal),
      this.listGroups(signal),
    ]);
    return { items: items.length, groups: groups.length };
  }

  async listEntries(
    query: VaultEntryQuery,
    signal?: AbortSignal,
  ): Promise<readonly VaultEntrySummary[]> {
    this.requireSession();
    const args = ['list', 'items'];
    if (query.groupId !== undefined) args.push('--folderid', query.groupId ?? 'null');
    if (query.search !== undefined && query.search.length > 0) args.push('--search', query.search);
    const items = await this.runJson(args, BwItemList, signal);
    const out: VaultEntrySummary[] = [];
    for (const item of items) {
      if (typeof item.name !== 'string') continue;
      out.push({
        id: item.id ?? '',
        name: item.name,
        groupId: normGroupId(item.folderId),
        uris: loginUris(item.login),
      });
    }
    return out;
  }

  async getEntry(ref: VaultEntryRef, signal?: AbortSignal): Promise<VaultEntry> {
    this.requireSession();
    const arg = ref.id !== undefined && ref.id.length > 0 ? ref.id : (ref.name ?? '');
    const result = await this.run(['get', 'item', '--', arg], {
      ...(signal !== undefined && { signal }),
    });
    if (result.code !== 0) {
      if (/not found/i.test(result.stderr)) throw notFound(arg);
      if (/locked|session|vault is locked/i.test(result.stderr)) throw locked();
      throw notFound(arg);
    }
    const item = parseJson(result.stdout, BwItem);
    const login = item.login;
    if (login === null || login === undefined || typeof login.password !== 'string')
      throw notFound(arg);
    return {
      id: item.id ?? arg,
      name: item.name ?? arg,
      groupId: normGroupId(item.folderId),
      uris: loginUris(login),
      username: typeof login.username === 'string' ? login.username : '',
      password: secret(login.password),
      ...(typeof login.totp === 'string' && login.totp.length > 0 && { totp: secret(login.totp) }),
    };
  }

  /** Every folder with exactly one synthetic ungrouped bucket, whatever `bw` reports. */
  async listGroups(signal?: AbortSignal): Promise<readonly VaultGroup[]> {
    this.requireSession();
    const raw = await this.runJson(['list', 'folders'], BwFolderList, signal);
    const groups: VaultGroup[] = [];
    let hasNull = false;
    for (const f of raw) {
      const id = normGroupId(f.id);
      if (id === null) {
        if (hasNull) continue;
        hasNull = true;
        groups.push({ id: null, name: NO_FOLDER_NAME });
        continue;
      }
      groups.push({ id, name: typeof f.name === 'string' ? f.name : '' });
    }
    if (!hasNull) groups.push({ id: null, name: NO_FOLDER_NAME });
    return groups;
  }

  // --- internals ------------------------------------------------------------------------------

  private requireSession(): void {
    if (this.session === null) throw locked();
  }

  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const path = this.deps.host.env['PATH'];
    if (path !== undefined) env['PATH'] = path;
    env['HOME'] = this.deps.host.env['HOME'] ?? this.deps.host.homeDir;
    if (this.session !== null) env['BW_SESSION'] = this.session.reveal();
    return env;
  }

  private async run(
    args: readonly string[],
    options: { signal?: AbortSignal },
  ): Promise<RunResult> {
    const startedAt = this.deps.clock.now();
    let result: RunResult & { timedOut: boolean };
    try {
      result = await this.deps.runner.run(this.binary, ['--nointeraction', ...args], {
        env: this.childEnv(),
        timeoutMs: this.timeoutMs,
        ...(options.signal !== undefined && { signal: options.signal }),
      });
    } catch (err) {
      if (err instanceof ProcessSpawnError && err.kind === 'not_found') {
        throw new AppError(
          'VAULT_BACKEND_ERROR',
          { backend: BACKEND, kind: 'not_installed' },
          { publicMessage: "Vault backend 'bitwarden' failed (not_installed).", cause: err },
        );
      }
      throw new AppError(
        'VAULT_BACKEND_ERROR',
        { backend: BACKEND, kind: 'exit' },
        { publicMessage: "Vault backend 'bitwarden' failed (exit).", cause: err },
      );
    }
    this.log.debug('bw invoked', {
      vault: true,
      command: args[0],
      code: result.code,
      timed_out: result.timedOut,
      duration_ms: this.deps.clock.now() - startedAt,
    });
    if (result.timedOut) {
      throw new AppError(
        'VAULT_BACKEND_ERROR',
        { backend: BACKEND, kind: 'timeout' },
        { publicMessage: "Vault backend 'bitwarden' failed (timeout)." },
      );
    }
    return result;
  }

  private async runOk(
    args: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<RunResult> {
    const result = await this.run(args, { ...(signal !== undefined && { signal }) });
    if (result.code !== 0) {
      if (/locked|session/i.test(result.stderr)) throw locked();
      throw new AppError(
        'VAULT_BACKEND_ERROR',
        { backend: BACKEND, kind: 'exit' },
        {
          publicMessage: "Vault backend 'bitwarden' failed (exit).",
          message: `bw ${args[0]} failed (exit ${result.code})`,
        },
      );
    }
    return result;
  }

  private async runJson<S extends z.ZodType>(
    args: readonly string[],
    schema: S,
    signal: AbortSignal | undefined,
  ): Promise<z.infer<S>> {
    const result = await this.runOk(args, signal);
    return parseJson(result.stdout, schema);
  }
}

function locked(): AppError<'VAULT_LOCKED'> {
  return new AppError('VAULT_LOCKED', { backend: BACKEND });
}

function notFound(entryName: string): AppError<'VAULT_ENTRY_NOT_FOUND'> {
  return new AppError(
    'VAULT_ENTRY_NOT_FOUND',
    { entry_name: entryName },
    { publicMessage: `Vault entry '${entryName}' is not in the backend.` },
  );
}

/** Parses `bw` JSON with `schema`; malformed output is a typed backend error (stdout is never echoed). */
function parseJson<S extends z.ZodType>(text: string, schema: S): z.infer<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(
      'VAULT_BACKEND_ERROR',
      { backend: BACKEND, kind: 'exit' },
      {
        publicMessage: "Vault backend 'bitwarden' failed (exit).",
        message: 'bw output is not JSON',
        cause: err,
      },
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      'VAULT_BACKEND_ERROR',
      { backend: BACKEND, kind: 'exit' },
      {
        publicMessage: "Vault backend 'bitwarden' failed (exit).",
        message: 'bw output has an unexpected shape',
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
}
