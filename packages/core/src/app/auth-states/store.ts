/** @module app/auth-states/store — AuthStateStore: save/list/remove/restore of saved auth snapshots under `<data-dir>/auth-states/`, scoped per principal (spec 02 §6, D-24, spec 13 T0a); implements the `AuthStateLocator` port. */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUTH_NAME_RE,
  type SavedAuthEntry as SavedAuthEntrySchema,
  type SavedAuthResult as SavedAuthResultSchema,
} from '@browserhive/contracts/tools';
import { z } from 'zod';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { pathNotAllowed } from '../../kernel/paths.ts';
import type { AuthStateLocator } from '../../ports/auth-state-locator.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import { unzipToDirectory, type ZipFs, zipDirectory } from './zip.ts';

/** Directory name under the data dir (D-24). */
export const AUTH_STATES_DIR_NAME = 'auth-states';
/** Directories 0700, secret files 0600 (D-24). */
export const AUTH_DIR_MODE = 0o700;
/** Snapshots hold live cookies/tokens: owner-only. */
export const AUTH_FILE_MODE = 0o600;
/** Owner assumed for a manifest without an `owner` field (the single shared `local` principal). */
export const DEFAULT_OWNER = 'local';

/** The filesystem the store needs (production: {@link createNodeAuthStateFs}). */
export interface AuthStateFs extends ZipFs {
  mkdir(dir: string, mode?: number): Promise<void>;
  /** `null` when the path does not exist. */
  stat(path: string): Promise<{ readonly size: number } | null>;
  chmod(path: string, mode: number): Promise<void>;
  /** Writes with `mode` (existing files are truncated; mode applied afterwards). */
  writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void>;
  remove(path: string): Promise<void>;
  /** Moves a file, replacing `to` when it exists. */
  rename(from: string, to: string): Promise<void>;
  /** Names of a directory's entries, or `[]` when it does not exist. */
  list(dir: string): Promise<readonly string[]>;
}

/** Anything that can write a Playwright storage state to a path (a `BrowserContext`). */
export interface StorageStateSource {
  /** `indexedDB` is required so a caller can never silently drop it again (Playwright's default is off). */
  storageState(options: { path: string; indexedDB: boolean }): Promise<unknown>;
}

/** Manifest written next to every snapshot (`<name>.meta.json`); `owner` is optional on read (spec 02 §6). */
export const AuthManifest = z.object({
  name: z.string(),
  kind: z.enum(['storage', 'profile']),
  saved_at: z.number(),
  source_session_id: z.string(),
  size: z.number(),
  owner: z.string().default(DEFAULT_OWNER),
});
/** Parsed {@link AuthManifest}. */
export type AuthManifest = z.infer<typeof AuthManifest>;

/** Result of both save operations (`{ name, path, size }`). */
export type SavedAuthResult = z.infer<typeof SavedAuthResultSchema>;
/** One `list_saved_auths` row. */
export type SavedAuthEntry = z.infer<typeof SavedAuthEntrySchema>;

const IdentitySeedFile = z.object({ seed: z.string().min(1) });

/** One snapshot of any principal, as the operator sees it (`GET /auth-states`). */
export interface AuthStateRecord {
  readonly name: string;
  readonly kind: 'storage' | 'profile';
  /** The principal subject that saved it. */
  readonly owner: string;
  readonly size: number;
  readonly saved_at: number;
  readonly source_session_id: string;
}

/** The change event the store publishes after a save or a delete (the `auth-states` topic). */
export interface AuthStateChangedEvent {
  readonly type: 'auth_state.changed';
  readonly owner: string;
  readonly name: string;
  readonly action: 'saved' | 'deleted';
}

/** Events the store publishes. */
export type AuthStateEvents = { readonly 'auth_state.changed': AuthStateChangedEvent };

/** Constructor dependencies of {@link AuthStateStore}. */
export interface AuthStateStoreDeps {
  readonly dataDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Where `auth_state.changed` goes (the dashboard's live refresh); omitted ⇒ nothing is published. */
  readonly events?: EventPublisher<AuthStateEvents>;
  /** Defaults to `node:fs/promises`. */
  readonly fs?: AuthStateFs;
}

/**
 * Validates an auth-state name. Names become file names, so the charset is conservative and any
 * traversal sequence is refused with `PATH_NOT_ALLOWED` — the same code the file sandbox uses, since
 * the risk is identical.
 *
 * @throws `PATH_NOT_ALLOWED`
 */
export function assertValidAuthName(name: string): void {
  if (!AUTH_NAME_RE.test(name) || name.includes('..')) throw pathNotAllowed(name, []);
}

function notFound(name: string, kind: 'storage' | 'profile'): AppError<'AUTH_STATE_NOT_FOUND'> {
  const kindLabel = kind === 'profile' ? 'full-profile' : 'storage-state';
  return new AppError(
    'AUTH_STATE_NOT_FOUND',
    { name, kind },
    {
      publicMessage: `No saved ${kindLabel} snapshot named '${name}'. Use list_saved_auths to see what is available.`,
    },
  );
}

/**
 * `AUTH_STATE_NOT_FOUND` for a request that names no kind (`delete_saved_auth`, the operator's
 * delete). The same text for a missing name and another principal's, so it reveals nothing.
 */
export function authStateNotFound(name: string): AppError<'AUTH_STATE_NOT_FOUND'> {
  return new AppError(
    'AUTH_STATE_NOT_FOUND',
    { name },
    {
      publicMessage: `No saved auth snapshot named '${name}'. Use list_saved_auths to see what is available.`,
    },
  );
}

/** Directory under `auth-states/` that holds one directory per non-`local` principal (spec 13 T0a). */
export const PRINCIPAL_DIRS_NAME = 'p';

/**
 * The directory name of a principal's snapshots under `auth-states/p/`: the first 16 hex chars of
 * SHA-256 of its subject. Hashed so any subject maps to a safe, fixed-length file name.
 */
export function principalDirName(subject: string): string {
  return createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 16);
}

/** The four files of one snapshot. */
export interface AuthStateFiles {
  /** `<name>.storage.json`. */
  readonly storage: string;
  /** `<name>.profile.zip`. */
  readonly profile: string;
  /** `<name>.identity.json`. */
  readonly identity: string;
  /** `<name>.meta.json`: its presence is what makes a snapshot exist. */
  readonly manifest: string;
}

/** Move and delete order: payloads and seed first, the manifest last, so an interrupted step can be resumed. */
const FILE_ORDER = ['storage', 'profile', 'identity', 'manifest'] as const;
const MANIFEST_SUFFIX = '.meta.json';

function isValidAuthName(name: string): boolean {
  return AUTH_NAME_RE.test(name) && !name.includes('..');
}

/**
 * Two snapshot kinds: `storage` (`<name>.storage.json`, cookies, localStorage and IndexedDB; restored into a
 * fresh non-persistent context) and `profile` (`<name>.profile.zip` of a managed `userdata`;
 * restored into a new persistent session). Each has a `<name>.meta.json` manifest so listings never
 * open the payload, and a profile may carry `<name>.identity.json` (`{ seed }` only).
 *
 * Names are scoped per principal (spec 13 T0a): `local` keeps the flat `auth-states/<name>.*`
 * layout, every other principal has `auth-states/p/<principalDirName(subject)>/<name>.*`. A name is
 * one snapshot per principal: saving either kind replaces the caller's other kind and seed, and two
 * principals using the same name never touch each other's files. Manifests left in the flat layout
 * by an older release with a non-`local` owner are moved into their owner's directory on the first
 * access after start ({@link AuthStateStore.migrateFlatLayout}).
 */
export class AuthStateStore implements AuthStateLocator {
  /** `<data-dir>/auth-states`. */
  readonly dir: string;
  private readonly deps: AuthStateStoreDeps;
  private readonly fs: AuthStateFs;
  private readonly log: Logger;
  /** The once-per-process flat-layout migration; reset when a step failed so the next access retries. */
  private migration: Promise<void> | null = null;

  constructor(deps: AuthStateStoreDeps) {
    this.deps = deps;
    this.fs = deps.fs ?? createNodeAuthStateFs();
    this.dir = join(deps.dataDir, AUTH_STATES_DIR_NAME);
    this.log = deps.logger.child({ module: 'auth-states' });
  }

  /** The directory of `subject`'s snapshots: `auth-states/` for `local`, `auth-states/p/<hash>/` otherwise. */
  dirFor(subject: string): string {
    return subject === DEFAULT_OWNER
      ? this.dir
      : join(this.dir, PRINCIPAL_DIRS_NAME, principalDirName(subject));
  }

  /** The paths of `subject`'s snapshot `name` (they need not exist). */
  filesFor(subject: string, name: string): AuthStateFiles {
    const dir = this.dirFor(subject);
    return {
      storage: join(dir, `${name}.storage.json`),
      profile: join(dir, `${name}.profile.zip`),
      identity: join(dir, `${name}.identity.json`),
      manifest: join(dir, `${name}${MANIFEST_SUFFIX}`),
    };
  }

  /** Saves a light storage-state snapshot from a live context (any persistence mode). */
  async saveStorageState(
    source: StorageStateSource,
    name: string,
    sourceSessionId: string,
    principal: SessionPrincipal,
  ): Promise<SavedAuthResult> {
    assertValidAuthName(name);
    const files = await this.prepareSave(name, principal);
    const path = files.storage;
    // IndexedDB is part of a login for many sites (Firebase Auth keeps its tokens there).
    await source.storageState({ path, indexedDB: true });
    // Playwright writes 0644; the snapshot holds cookies/tokens, so pin it owner-only.
    await this.fs.chmod(path, AUTH_FILE_MODE);
    const size = (await this.fs.stat(path))?.size ?? 0;
    await this.replaceStale(files, 'storage');
    await this.writeManifest(files, {
      name,
      kind: 'storage',
      saved_at: this.deps.clock.now(),
      source_session_id: sourceSessionId,
      size,
      owner: principal.subject,
    });
    this.changed(principal.subject, name, 'saved');
    return { name, path, size };
  }

  /**
   * Saves a heavy full-profile snapshot by zipping a managed `userdata` dir (the caller enforces
   * `persistent` mode). Chromium commits DOM storage lazily, so a snapshot of a live profile may
   * miss the very latest writes; snapshot while the session is idle for the most consistent copy.
   */
  async saveFullProfile(
    userDataDir: string,
    name: string,
    sourceSessionId: string,
    principal: SessionPrincipal,
  ): Promise<SavedAuthResult> {
    assertValidAuthName(name);
    const files = await this.prepareSave(name, principal);
    const path = files.profile;
    const archive = await zipDirectory(userDataDir, this.fs);
    await this.fs.writeFile(path, archive, AUTH_FILE_MODE);
    const size = archive.byteLength;
    await this.replaceStale(files, 'profile');
    await this.writeManifest(files, {
      name,
      kind: 'profile',
      saved_at: this.deps.clock.now(),
      source_session_id: sourceSessionId,
      size,
      owner: principal.subject,
    });
    this.changed(principal.subject, name, 'saved');
    return { name, path, size };
  }

  /**
   * Saves the presented-identity seed beside the caller's own profile snapshot `name`. Only the seed
   * (the display metrics are a pure function of it); the geo half is re-resolved on restore.
   * Best-effort: a failure (including no such profile of the caller's) is logged and reported as
   * `false`, never thrown — a snapshot that restores with a fresh identity is still a usable snapshot.
   */
  async saveIdentitySeed(
    name: string,
    seed: string,
    principal: SessionPrincipal,
  ): Promise<boolean> {
    assertValidAuthName(name);
    try {
      const own = await this.ownSnapshot(name, principal);
      if (own === null || own.manifest.kind !== 'profile') {
        this.log.warn('identity seed: no profile', { name });
        return false;
      }
      await this.fs.writeFile(
        own.files.identity,
        JSON.stringify({ seed }, null, 2),
        AUTH_FILE_MODE,
      );
      return true;
    } catch (err) {
      this.log.warn('identity seed save failed', { name, err: serializeError(err) });
      return false;
    }
  }

  /** The seed saved beside the caller's profile `name`, or `null` (absent, malformed, not a profile, or pre-identity snapshot). */
  async loadIdentitySeed(name: string, principal: SessionPrincipal): Promise<string | null> {
    assertValidAuthName(name);
    try {
      const own = await this.ownSnapshot(name, principal);
      if (own === null || own.manifest.kind !== 'profile') return null;
      const raw = await this.fs.readFile(own.files.identity);
      const parsed = IdentitySeedFile.safeParse(JSON.parse(new TextDecoder().decode(raw)));
      return parsed.success ? parsed.data.seed : null;
    } catch {
      // Absent or malformed: the caller derives a fresh identity instead.
      return null;
    }
  }

  /**
   * The caller's storage-state snapshot file.
   *
   * @throws `AUTH_STATE_NOT_FOUND` `{ name, kind: 'storage' }` (also for another principal's snapshot or a profile of that name).
   */
  async storageStatePath(name: string, principal: SessionPrincipal): Promise<string> {
    assertValidAuthName(name);
    const own = await this.ownSnapshot(name, principal);
    if (
      own === null ||
      own.manifest.kind !== 'storage' ||
      (await this.fs.stat(own.files.storage)) === null
    ) {
      throw notFound(name, 'storage');
    }
    return own.files.storage;
  }

  /**
   * Extracts the caller's profile snapshot into `userDataDir`.
   *
   * @throws `AUTH_STATE_NOT_FOUND` `{ name, kind: 'profile' }` (also for another principal's snapshot or a storage state of that name); `PATH_NOT_ALLOWED` on a zip-slip entry.
   */
  async restoreProfile(
    name: string,
    userDataDir: string,
    principal: SessionPrincipal,
  ): Promise<void> {
    assertValidAuthName(name);
    const own = await this.ownSnapshot(name, principal);
    if (own === null || own.manifest.kind !== 'profile') throw notFound(name, 'profile');
    let archive: Uint8Array;
    try {
      archive = await this.fs.readFile(own.files.profile);
    } catch (err) {
      throw new AppError(
        'AUTH_STATE_NOT_FOUND',
        { name, kind: 'profile' },
        {
          publicMessage: notFound(name, 'profile').publicMessage,
          cause: err,
        },
      );
    }
    await unzipToDirectory(archive, userDataDir, this.fs);
  }

  /** The caller's snapshots, newest first. Malformed or orphan manifests are skipped. */
  async list(principal: SessionPrincipal): Promise<SavedAuthEntry[]> {
    await this.ready();
    const entries: SavedAuthEntry[] = [];
    const dir = this.dirFor(principal.subject);
    for (const file of await this.fs.list(dir)) {
      if (!file.endsWith(MANIFEST_SUFFIX)) continue;
      const manifest = await this.readManifest(join(dir, file));
      if (manifest === null || manifest.owner !== principal.subject) continue;
      entries.push({
        name: manifest.name,
        kind: manifest.kind,
        saved_at: manifest.saved_at,
        size: manifest.size,
      });
    }
    entries.sort((a, b) => b.saved_at - a.saved_at);
    return entries;
  }

  /**
   * Deletes every file of a snapshot the caller owns, whatever is left of it (manifest last, so an
   * interrupted delete can be repeated). `false` when the caller has no snapshot of that name.
   */
  async remove(name: string, principal: SessionPrincipal): Promise<boolean> {
    return (await this.removeSnapshot(principal.subject, name)) !== null;
  }

  /**
   * The operator's delete: removes `owner`'s snapshot `name` and returns what it was, or `null`
   * when `owner` has no snapshot of that name.
   */
  async removeSnapshot(owner: string, name: string): Promise<AuthStateRecord | null> {
    assertValidAuthName(name);
    const own = await this.ownSnapshot(name, { subject: owner });
    if (own === null) return null;
    await this.removeFiles(own.files);
    this.changed(owner, name, 'deleted');
    return recordOf(own.manifest);
  }

  /**
   * Every principal's snapshots, newest first: the operator's view (`GET /auth-states`). A
   * per-principal directory only contributes manifests whose owner hashes to it, and the flat
   * layout only `local`'s, so what is listed is exactly what {@link removeSnapshot} can reach.
   */
  async listAll(): Promise<AuthStateRecord[]> {
    await this.ready();
    const records: AuthStateRecord[] = [];
    const collect = async (dir: string, accepts: (owner: string) => boolean) => {
      for (const file of await this.fs.list(dir)) {
        if (!file.endsWith(MANIFEST_SUFFIX)) continue;
        const manifest = await this.readManifest(join(dir, file));
        if (manifest !== null && accepts(manifest.owner)) records.push(recordOf(manifest));
      }
    };
    await collect(this.dir, (owner) => owner === DEFAULT_OWNER);
    const principalsDir = join(this.dir, PRINCIPAL_DIRS_NAME);
    for (const entry of await this.fs.list(principalsDir)) {
      await collect(
        join(principalsDir, entry),
        (owner) => owner !== DEFAULT_OWNER && principalDirName(owner) === entry,
      );
    }
    records.sort((a, b) => b.saved_at - a.saved_at);
    return records;
  }

  /**
   * Moves every flat-layout snapshot whose manifest names a non-`local` owner into that owner's
   * directory (spec 13 T0a). Runs once per process before the first access; safe to repeat. Each
   * name moves payloads and seed first and its manifest last, so a crash mid-move leaves the flat
   * manifest in place and the next start finishes the move without losing a file. When the owner
   * already has a snapshot of that name (a downgraded release saved one flat), the newer one wins.
   *
   * @returns `true` when every flat snapshot was handled.
   */
  async migrateFlatLayout(): Promise<boolean> {
    let complete = true;
    for (const file of await this.fs.list(this.dir)) {
      if (!file.endsWith(MANIFEST_SUFFIX)) continue;
      const name = file.slice(0, -MANIFEST_SUFFIX.length);
      if (!isValidAuthName(name)) continue;
      const manifest = await this.readManifest(join(this.dir, file));
      if (manifest === null || manifest.owner === DEFAULT_OWNER) continue;
      try {
        await this.moveToOwner(name, manifest);
      } catch (err) {
        complete = false;
        this.log.warn('auth state move failed', {
          name,
          err: serializeError(err),
        });
      }
    }
    return complete;
  }

  private changed(owner: string, name: string, action: 'saved' | 'deleted'): void {
    this.deps.events?.publish('auth_state.changed', {
      type: 'auth_state.changed',
      owner,
      name,
      action,
    });
  }

  private ready(): Promise<void> {
    this.migration ??= this.migrateFlatLayout().then(
      (complete) => {
        if (!complete) this.migration = null;
      },
      (err: unknown) => {
        this.migration = null;
        this.log.warn('auth state migrate failed', { err: serializeError(err) });
      },
    );
    return this.migration;
  }

  private async moveToOwner(name: string, flat: AuthManifest): Promise<void> {
    const from = this.filesFor(DEFAULT_OWNER, name);
    const to = this.filesFor(flat.owner, name);
    await this.fs.mkdir(this.dirFor(flat.owner), AUTH_DIR_MODE);
    const existing = await this.readManifest(to.manifest);
    if (existing !== null) {
      if (existing.saved_at >= flat.saved_at) {
        await this.removeFiles(from);
        this.log.info('stale flat copy dropped', { name });
        return;
      }
      await this.removeFiles(to);
    }
    for (const key of FILE_ORDER) {
      if ((await this.fs.stat(from[key])) === null) continue;
      await this.fs.rename(from[key], to[key]);
    }
    this.log.info('auth state moved to owner', { name });
  }

  /**
   * Creates the caller's directory and returns the snapshot's paths. A flat manifest of that name
   * still owned by someone else (its move failed earlier) is moved first, so a `local` save never
   * overwrites another principal's snapshot.
   */
  private async prepareSave(name: string, principal: SessionPrincipal): Promise<AuthStateFiles> {
    await this.ready();
    const files = this.filesFor(principal.subject, name);
    await this.fs.mkdir(this.dirFor(principal.subject), AUTH_DIR_MODE);
    if (principal.subject === DEFAULT_OWNER) {
      const existing = await this.readManifest(files.manifest);
      if (existing !== null && existing.owner !== DEFAULT_OWNER) {
        await this.moveToOwner(name, existing);
      }
    }
    return files;
  }

  /** One name is one snapshot: drops the other kind's payload and the seed before the new manifest lands. */
  private async replaceStale(files: AuthStateFiles, kind: 'storage' | 'profile'): Promise<void> {
    await this.fs.remove(kind === 'storage' ? files.profile : files.storage);
    await this.fs.remove(files.identity);
  }

  /** The caller's snapshot `name` when its manifest exists and names the caller as owner. */
  private async ownSnapshot(
    name: string,
    principal: SessionPrincipal,
  ): Promise<{ readonly files: AuthStateFiles; readonly manifest: AuthManifest } | null> {
    await this.ready();
    const files = this.filesFor(principal.subject, name);
    const manifest = await this.readManifest(files.manifest);
    // A manifest without `owner` belongs to `local`, and only `local` reads the flat layout.
    if (manifest === null || manifest.owner !== principal.subject) return null;
    return { files, manifest };
  }

  private async removeFiles(files: AuthStateFiles): Promise<void> {
    for (const key of FILE_ORDER) await this.fs.remove(files[key]);
  }

  private async readManifest(path: string): Promise<AuthManifest | null> {
    try {
      const raw = await this.fs.readFile(path);
      const parsed = AuthManifest.safeParse(JSON.parse(new TextDecoder().decode(raw)));
      return parsed.success ? parsed.data : null;
    } catch {
      // Absent / unreadable / malformed: no snapshot, rather than failing the whole listing.
      return null;
    }
  }

  private async writeManifest(files: AuthStateFiles, manifest: AuthManifest): Promise<void> {
    await this.fs.writeFile(files.manifest, JSON.stringify(manifest, null, 2), AUTH_FILE_MODE);
  }
}

function recordOf(manifest: AuthManifest): AuthStateRecord {
  return {
    name: manifest.name,
    kind: manifest.kind,
    owner: manifest.owner,
    size: manifest.size,
    saved_at: manifest.saved_at,
    source_session_id: manifest.source_session_id,
  };
}

/** The `node:fs/promises` implementation of {@link AuthStateFs}. */
export function createNodeAuthStateFs(): AuthStateFs {
  return {
    async readdir(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
    },
    readFile: (path) => readFile(path),
    async writeFile(path, data, mode) {
      await writeFile(path, data, mode === undefined ? {} : { mode });
      if (mode !== undefined) await chmod(path, mode);
    },
    async mkdir(dir, mode) {
      await mkdir(dir, { recursive: true, ...(mode !== undefined && { mode }) });
    },
    async stat(path) {
      try {
        return { size: (await stat(path)).size };
      } catch {
        // Missing path is a regular answer here.
        return null;
      }
    },
    chmod: (path, mode) => chmod(path, mode),
    remove: (path) => rm(path, { force: true }),
    rename: (from, to) => rename(from, to),
    async list(dir) {
      try {
        return await readdir(dir);
      } catch {
        // Directory not created yet → nothing saved.
        return [];
      }
    },
  };
}
