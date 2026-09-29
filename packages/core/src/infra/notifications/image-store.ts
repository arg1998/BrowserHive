/** @module infra/notifications/image-store — notification screenshots on disk (D-36, spec 03 §9.5): `<dataDir>/notifications/images/`, directory 0700, files 0600, named by an opaque ref that is validated before any path is built. */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  NotificationImage,
  NotificationImageStore,
} from '../../ports/notification-channel.ts';

/** Shape of an image ref: `nimg-` + 16 URL-safe characters. Anything else never reaches the disk. */
export const IMAGE_REF_RE = /^nimg-[A-Za-z0-9_-]{16}$/;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Options of {@link createNotificationImageStore}. */
export interface ImageStoreOptions {
  /** Opaque id source (16 URL-safe characters); defaults to crypto random bytes. */
  readonly ids?: { opaque(size: number): string };
}

function randomId(size: number): string {
  return randomBytes(size).toString('base64url').slice(0, size);
}

/**
 * The filesystem image store. `read` returns `null` for an unknown or malformed ref, so a pruned
 * screenshot makes the adapter send the text alone.
 *
 * @returns The store.
 */
export function createNotificationImageStore(
  dir: string,
  options: ImageStoreOptions = {},
): NotificationImageStore {
  const opaque = (size: number) => options.ids?.opaque(size) ?? randomId(size);
  let ready: Promise<void> | undefined;
  const ensure = () => {
    ready ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    return ready;
  };

  async function find(ref: string): Promise<string | null> {
    if (!IMAGE_REF_RE.test(ref)) return null;
    for (const ext of Object.keys(TYPES)) {
      const path = join(dir, `${ref}.${ext}`);
      try {
        await stat(path);
        return path;
      } catch {
        // try the next extension
      }
    }
    return null;
  }

  return {
    async put(image: NotificationImage): Promise<string> {
      await ensure();
      const ref = `nimg-${opaque(16)}`;
      if (!IMAGE_REF_RE.test(ref))
        throw new TypeError('image ref generator produced an invalid ref');
      const ext = EXTENSIONS[image.contentType] ?? 'jpg';
      await writeFile(join(dir, `${ref}.${ext}`), image.bytes, { mode: 0o600 });
      return ref;
    },

    async read(ref: string): Promise<NotificationImage | null> {
      const path = await find(ref);
      if (path === null) return null;
      try {
        const bytes = new Uint8Array(await readFile(path));
        const ext = path.slice(path.lastIndexOf('.') + 1);
        return {
          bytes,
          contentType: TYPES[ext] ?? 'image/jpeg',
          filename: `screenshot.${ext}`,
        };
      } catch {
        return null;
      }
    },

    async prune(olderThan: number): Promise<number> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        const ref = name.replace(/\.[a-z]+$/, '');
        if (!IMAGE_REF_RE.test(ref)) continue;
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < olderThan) {
            await unlink(path);
            removed++;
          }
        } catch {
          // already gone
        }
      }
      return removed;
    },
  };
}
