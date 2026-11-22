/** @module scripts/registry/sync — `registry-build.ts --sync` (spec 13 §10.7, D-81): rewrites `registry/packs` and `registry/versions` canonically, copies each pack's current file into `registry/archive/<id>/<sha256>.json` and records that SHA-256 on the current version's entry of `registry/versions/<id>.json` (a new entry gets today's date and empty notes, which the check then asks you to write). A version that is already published (its entry has another SHA-256) is never rewritten: the check refuses the change instead. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../registry-common.mjs';

/** What {@link syncRegistry} did, one line per change. */
export function syncRegistry(repo: string, today: string): string[] {
  const done: string[] = [];
  const dir = (name: string) => join(repo, 'registry', name);
  mkdirSync(dir('versions'), { recursive: true });
  for (const name of readdirSync(dir('packs'))
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const id = name.slice(0, -'.json'.length);
    const packPath = join(dir('packs'), name);
    const text = canonicalJson(JSON.parse(readFileSync(packPath, 'utf8')));
    writeFileSync(packPath, text);
    const bytes = Buffer.from(text);
    const sha256 = sha256Hex(bytes);
    const version = String((JSON.parse(text) as { version: unknown }).version);
    const versionsPath = join(dir('versions'), name);
    const meta = (
      existsSync(versionsPath)
        ? JSON.parse(readFileSync(versionsPath, 'utf8'))
        : { schema: 1, versions: {} }
    ) as { schema: number; versions: Record<string, Record<string, unknown>> };
    const entry = meta.versions[version];
    if (entry !== undefined && entry['sha256'] !== undefined && entry['sha256'] !== sha256) {
      done.push(`${id} v${version}: already published with other content; raise the version`);
    } else {
      meta.versions[version] = { released: today, notes: '', ...entry, sha256 };
      const archive = join(dir('archive'), id);
      mkdirSync(archive, { recursive: true });
      const target = join(archive, `${sha256}.json`);
      if (!existsSync(target)) {
        writeFileSync(target, bytes);
        done.push(`${id} v${version}: archived as registry/archive/${id}/${sha256}.json`);
      }
    }
    writeFileSync(versionsPath, canonicalJson(meta));
  }
  return done;
}
