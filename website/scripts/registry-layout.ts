/**
 * The signed site-pack registry inside the built site (spec 13 §10.8): which files a signed layout
 * may hold and where they land under `dist/registry/v1/`. Signatures are verified before this runs
 * (`scripts/registry-sign.mjs` in the repository; the website never imports the pack schema); this
 * only refuses anything that is not a signed layout, so an unsigned or stray file is never served.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The four files every signed layout has. */
export const SIGNED_FILES = ['keys.json', 'keys.json.sig', 'index.json', 'index.json.sig'] as const;

const PACK_PATH = /^packs\/[a-z0-9.-]{4,253}\/[0-9a-f]{64}\.json$/;

/** Every file under `dir`, relative and with `/` separators. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Why `files` is not a signed layout, or `null`. */
export function layoutProblem(files: readonly string[]): string | null {
  for (const name of SIGNED_FILES) if (!files.includes(name)) return `${name} is missing`;
  const stray = files.find(
    (f) => !(SIGNED_FILES as readonly string[]).includes(f) && !PACK_PATH.test(f),
  );
  return stray === undefined ? null : `${stray} does not belong in a registry layout`;
}

/**
 * Copies the signed layout in `from` to `<dist>/registry/v1/`, replacing what was there.
 *
 * @returns The number of files copied (0 when `from` does not exist: nothing is published yet).
 * @throws When `from` is not a signed layout.
 */
export function copyRegistry(from: string, dist: string): number {
  if (!existsSync(from)) return 0;
  const files = filesUnder(from);
  if (files.length === 0) return 0;
  const problem = layoutProblem(files);
  if (problem !== null) throw new Error(`not a signed registry layout: ${problem}`);
  const target = join(dist, 'registry', 'v1');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    mkdirSync(join(target, file, '..'), { recursive: true });
    cpSync(join(from, file), join(target, file));
  }
  return files.length;
}
