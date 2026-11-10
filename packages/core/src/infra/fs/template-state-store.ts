/** @module infra/fs/template-state-store — the encrypted checkpoint and version files of templates (spec 13 §2.4): `templates/<id>/versions/latest.state.enc` and `v<N>.state.enc` (+ `v<N>.meta.json`), each an AES-256-GCM envelope written to `.tmp` with mode 0600, `fsync`ed and renamed. Plaintext exists only in memory. */

import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EnvelopeError,
  openEnvelope,
  readEnvelopeHeader,
  type StateSlot,
  sealEnvelope,
  type TemplateKey,
} from '../../domain/templates/envelope.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { TemplateStateFileRecord } from '../../ports/persistence/index.ts';
import type {
  StateFileInfo,
  TemplateKeyRing,
  TemplateState,
  TemplateStateStore,
} from '../../ports/template-state.ts';

/** `latest.state.enc` or `v<N>.state.enc`. */
export function stateFileName(slot: StateSlot): string {
  return slot === 'latest' ? 'latest.state.enc' : `v${slot}.state.enc`;
}

const STATE_FILE_RE = /^(?:latest|v([1-9][0-9]{0,8}))\.state\.enc$/;

function slotOfFile(name: string): StateSlot | null {
  const match = STATE_FILE_RE.exec(name);
  if (match === null) return null;
  return match[1] === undefined ? 'latest' : Number(match[1]);
}

/** `TEMPLATE_VERSION_UNREADABLE` for one slot. */
export function unreadable(
  templateId: string,
  slot: StateSlot,
  keyId: string | null,
  why: string,
): AppError<'TEMPLATE_VERSION_UNREADABLE'> {
  return new AppError(
    'TEMPLATE_VERSION_UNREADABLE',
    { template_id: templateId, version: slot, key_id: keyId ?? '' },
    {
      publicMessage: `Version ${String(slot)} of template '${templateId}' cannot be read (${why}).`,
    },
  );
}

/** Writes `bytes` to `path` through `<path>.tmp` (0600), `fsync` and rename; the temp file never survives a failure. */
export async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    // A stale `.tmp` (an interrupted write) is removed first, so the new file is created with 0600
    // rather than inheriting the old file's mode.
    await rm(tmp, { force: true });
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Options of {@link FileTemplateStateStore}. */
export interface FileTemplateStateStoreOptions {
  /** `<data-dir>/templates`. */
  readonly templatesDir: string;
  readonly keys: TemplateKeyRing;
}

/** {@link TemplateStateStore} over the template directories. */
export class FileTemplateStateStore implements TemplateStateStore {
  readonly keys: TemplateKeyRing;
  readonly #root: string;

  constructor(options: FileTemplateStateStoreOptions) {
    this.#root = options.templatesDir;
    this.keys = options.keys;
  }

  /** `<templates>/<id>/versions`. */
  dirOf(templateId: string): string {
    return join(this.#root, templateId, 'versions');
  }

  async write(
    templateId: string,
    slot: StateSlot,
    state: TemplateState,
  ): Promise<TemplateStateFileRecord> {
    const key = this.keys.current;
    if (key === null) throw unreadable(templateId, slot, null, 'no template key');
    return await this.writeWith(templateId, slot, state, key);
  }

  /** Encrypts with `key` (also used by `rekey`). */
  async writeWith(
    templateId: string,
    slot: StateSlot,
    state: TemplateState,
    key: TemplateKey,
  ): Promise<TemplateStateFileRecord> {
    const dir = this.dirOf(templateId);
    await mkdir(join(this.#root, templateId), { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
    const sealed = sealEnvelope(plaintext, key, templateId, slot);
    plaintext.fill(0);
    await writeAtomic(join(dir, stateFileName(slot)), sealed);
    return {
      sizeBytes: sealed.length,
      sha256: createHash('sha256').update(sealed).digest('hex'),
      keyId: key.keyId,
    };
  }

  async read(templateId: string, slot: StateSlot): Promise<TemplateState> {
    const { state } = await this.readWithKey(templateId, slot);
    return state;
  }

  /** Decrypts one slot and reports which key opened it (`rekey`). */
  async readWithKey(
    templateId: string,
    slot: StateSlot,
    extraKeys: readonly TemplateKey[] = [],
  ): Promise<{ readonly state: TemplateState; readonly key: TemplateKey }> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.dirOf(templateId), stateFileName(slot)));
    } catch {
      throw unreadable(templateId, slot, null, 'the file is missing');
    }
    const keys = [this.keys.current, this.keys.previous, ...extraKeys].filter(
      (k): k is TemplateKey => k !== null,
    );
    try {
      const opened = openEnvelope(bytes, keys, templateId, slot);
      const text = Buffer.from(opened.plaintext).toString('utf8');
      return { state: JSON.parse(text) as TemplateState, key: opened.key };
    } catch (err) {
      if (err instanceof EnvelopeError) {
        const why =
          err.failure === 'key_mismatch'
            ? 'written with another key'
            : err.failure === 'auth_failed'
              ? 'the file failed authentication'
              : 'not a template state file';
        throw unreadable(templateId, slot, err.keyId, keys.length === 0 ? 'no template key' : why);
      }
      throw unreadable(templateId, slot, null, 'the content is not a storage state');
    }
  }

  async remove(templateId: string, slot: StateSlot): Promise<void> {
    const dir = this.dirOf(templateId);
    await rm(join(dir, stateFileName(slot)), { force: true });
    if (slot !== 'latest') await rm(join(dir, `v${slot}.meta.json`), { force: true });
  }

  async writeMeta(
    templateId: string,
    version: number,
    meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const text = `${JSON.stringify(meta, null, 2)}\n`;
    await writeAtomic(join(this.dirOf(templateId), `v${version}.meta.json`), Buffer.from(text));
  }

  async files(templateId: string): Promise<readonly StateFileInfo[]> {
    const dir = this.dirOf(templateId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: StateFileInfo[] = [];
    for (const name of names) {
      const slot = slotOfFile(name);
      if (slot === null) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        const head = await readHead(path);
        out.push({ slot, keyId: readEnvelopeHeader(head)?.keyId ?? null, sizeBytes: info.size });
      } catch {
        // Vanished meanwhile.
      }
    }
    return out;
  }

  async templatesWithFiles(): Promise<readonly string[]> {
    let ids: string[];
    try {
      ids = await readdir(this.#root);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const id of ids.sort()) {
      if ((await this.files(id)).length > 0) out.push(id);
    }
    return out;
  }

  async removeTemporaries(templateId: string): Promise<number> {
    const dir = this.dirOf(templateId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    const tmp = names.filter((n) => n.endsWith('.tmp'));
    for (const name of tmp) await rm(join(dir, name), { force: true });
    return tmp.length;
  }
}

/** The first bytes of a file: enough for the envelope header and a tag. */
async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
