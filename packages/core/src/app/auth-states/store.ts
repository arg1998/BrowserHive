/** @module app/auth-states/store — AuthStateStore: save/list/remove/restore of saved auth snapshots under `<data-dir>/auth-states/` (spec 02 §6, D-24); implements the `AuthStateLocator` port. */

import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/** Constructor dependencies of {@link AuthStateStore}. */
export interface AuthStateStoreDeps {
  readonly dataDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
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
 * Two snapshot kinds: `storage` (`<name>.storage.json`, cookies, localStorage and IndexedDB; restored into a
 * fresh non-persistent context) and `profile` (`<name>.profile.zip` of a managed `userdata`;
 * restored into a new persistent session). Each has a `<name>.meta.json` manifest so listings never
 * open the payload, and a profile may carry `<name>.identity.json` (`{ seed }` only).
 */
export class AuthStateStore implements AuthStateLocator {
  /** `<data-dir>/auth-states`. */
  readonly dir: string;
  private readonly deps: AuthStateStoreDeps;
  private readonly fs: AuthStateFs;
  private readonly log: Logger;

  constructor(deps: AuthStateStoreDeps) {
    this.deps = deps;
    this.fs = deps.fs ?? createNodeAuthStateFs();
    this.dir = join(deps.dataDir, AUTH_STATES_DIR_NAME);
    this.log = deps.logger.child({ module: 'auth-states' });
  }

  /** `<name>.storage.json`. */
  storageStateFile(name: string): string {
    return join(this.dir, `${name}.storage.json`);
  }

  /** `<name>.profile.zip`. */
  profileZipFile(name: string): string {
    return join(this.dir, `${name}.profile.zip`);
  }

  /** `<name>.meta.json`. */
  manifestFile(name: string): string {
    return join(this.dir, `${name}.meta.json`);
  }

  /** `<name>.identity.json`. */
  identitySeedFile(name: string): string {
    return join(this.dir, `${name}.identity.json`);
  }

  /** Saves a light storage-state snapshot from a live context (any persistence mode). */
  async saveStorageState(
    source: StorageStateSource,
    name: string,
    sourceSessionId: string,
    principal: SessionPrincipal,
  ): Promise<SavedAuthResult> {
    assertValidAuthName(name);
    await this.fs.mkdir(this.dir, AUTH_DIR_MODE);
    const path = this.storageStateFile(name);
    // IndexedDB is part of a login for many sites (Firebase Auth keeps its tokens there).
    await source.storageState({ path, indexedDB: true });
    // Playwright writes 0644; the snapshot holds cookies/tokens, so pin it owner-only.
    await this.fs.chmod(path, AUTH_FILE_MODE);
    const size = (await this.fs.stat(path))?.size ?? 0;
    await this.writeManifest({
      name,
      kind: 'storage',
      saved_at: this.deps.clock.now(),
      source_session_id: sourceSessionId,
      size,
      owner: principal.subject,
    });
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
    await this.fs.mkdir(this.dir, AUTH_DIR_MODE);
    const path = this.profileZipFile(name);
    const archive = await zipDirectory(userDataDir, this.fs);
    await this.fs.writeFile(path, archive, AUTH_FILE_MODE);
    const size = archive.byteLength;
    await this.writeManifest({
      name,
      kind: 'profile',
      saved_at: this.deps.clock.now(),
      source_session_id: sourceSessionId,
      size,
      owner: principal.subject,
    });
    return { name, path, size };
  }

  /**
   * Saves the presented-identity seed beside a profile. Only the seed (the display metrics are a
   * pure function of it); the geo half is re-resolved on restore. Best-effort: a failure is logged
   * and reported as `false`, never thrown — a snapshot that restores with a fresh identity is
   * still a usable snapshot.
   */
  async saveIdentitySeed(name: string, seed: string): Promise<boolean> {
    assertValidAuthName(name);
    try {
      await this.fs.mkdir(this.dir, AUTH_DIR_MODE);
      await this.fs.writeFile(
        this.identitySeedFile(name),
        JSON.stringify({ seed }, null, 2),
        AUTH_FILE_MODE,
      );
      return true;
    } catch (err) {
      this.log.warn('identity seed save failed', { name, err: serializeError(err) });
      return false;
    }
  }

  /** The seed saved beside a profile, or `null` (absent, malformed, or pre-identity snapshot). */
  async loadIdentitySeed(name: string): Promise<string | null> {
    assertValidAuthName(name);
    try {
      const raw = await this.fs.readFile(this.identitySeedFile(name));
      const parsed = IdentitySeedFile.safeParse(JSON.parse(new TextDecoder().decode(raw)));
      return parsed.success ? parsed.data.seed : null;
    } catch {
      // Absent or malformed: the caller derives a fresh identity instead.
      return null;
    }
  }

  /** @throws `AUTH_STATE_NOT_FOUND` `{ name, kind: 'storage' }` (also for another principal's snapshot). */
  async storageStatePath(name: string, principal: SessionPrincipal): Promise<string> {
    assertValidAuthName(name);
    const path = this.storageStateFile(name);
    if ((await this.fs.stat(path)) === null || !(await this.ownedBy(name, principal))) {
      throw notFound(name, 'storage');
    }
    return path;
  }

  /** @throws `AUTH_STATE_NOT_FOUND` `{ name, kind: 'profile' }`; `PATH_NOT_ALLOWED` on a zip-slip entry. */
  async restoreProfile(
    name: string,
    userDataDir: string,
    principal: SessionPrincipal,
  ): Promise<void> {
    assertValidAuthName(name);
    if (!(await this.ownedBy(name, principal))) throw notFound(name, 'profile');
    let archive: Uint8Array;
    try {
      archive = await this.fs.readFile(this.profileZipFile(name));
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
    const entries: SavedAuthEntry[] = [];
    for (const file of await this.fs.list(this.dir)) {
      if (!file.endsWith('.meta.json')) continue;
      const manifest = await this.readManifest(file.slice(0, -'.meta.json'.length));
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

  /** Deletes every file of a snapshot the caller owns. `false` when nothing was removed. */
  async remove(name: string, principal: SessionPrincipal): Promise<boolean> {
    assertValidAuthName(name);
    const manifest = await this.readManifest(name);
    if (manifest === null || manifest.owner !== principal.subject) return false;
    for (const path of [
      this.storageStateFile(name),
      this.profileZipFile(name),
      this.identitySeedFile(name),
      this.manifestFile(name),
    ]) {
      await this.fs.remove(path);
    }
    return true;
  }

  private async ownedBy(name: string, principal: SessionPrincipal): Promise<boolean> {
    const manifest = await this.readManifest(name);
    // A snapshot without a manifest, or a manifest without `owner`, belongs to `local`.
    const owner = manifest?.owner ?? DEFAULT_OWNER;
    return owner === principal.subject;
  }

  private async readManifest(name: string): Promise<AuthManifest | null> {
    try {
      const raw = await this.fs.readFile(this.manifestFile(name));
      const parsed = AuthManifest.safeParse(JSON.parse(new TextDecoder().decode(raw)));
      return parsed.success ? parsed.data : null;
    } catch {
      // Unreadable / malformed: skipped rather than failing the whole listing.
      return null;
    }
  }

  private async writeManifest(manifest: AuthManifest): Promise<void> {
    await this.fs.writeFile(
      this.manifestFile(manifest.name),
      JSON.stringify(manifest, null, 2),
      AUTH_FILE_MODE,
    );
  }
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
