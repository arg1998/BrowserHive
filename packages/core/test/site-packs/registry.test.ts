/** @module test/site-packs/registry.test — the registry's source of truth, `registry/packs/<id>.json` (spec 13 §9.8, §10.7): every file passes the schema and the refinements, is named for its id, and is canonical JSON (keys sorted at every level, two-space indentation and a final newline), so diffs stay stable and the published bytes are the reviewed ones; `registry/versions/<id>.json` lists the current version with its release date and notes. The full check (history, base comparison, classification) is `bun scripts/registry-build.ts --check`. An empty folder passes. */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { issuesText, loadPackBytes } from '../../src/domain/site-packs/load.ts';

/** `registry/packs` at the repository root (this file lives at packages/core/test/site-packs). */
const PACKS = resolve(import.meta.dir, '..', '..', '..', '..', 'registry', 'packs');
/** `registry/versions` beside it. */
const VERSIONS = resolve(PACKS, '..', 'versions');
/** The release the bundled packs target. */
const BINARY = '0.3.0';

/** Canonical JSON (the producers' `canonicalJson`, `scripts/registry-common.mjs`). */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

const Versions = z.strictObject({
  schema: z.literal(1),
  versions: z.record(
    z.string(),
    z.strictObject({
      released: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      notes: z.string().min(1).max(500),
      revoked: z.literal(true).optional(),
    }),
  ),
});

const files = existsSync(PACKS)
  ? readdirSync(PACKS)
      .filter((name) => name.endsWith('.json'))
      .sort()
  : [];

describe('registry/packs', () => {
  it('holds only pack files', () => {
    const others = existsSync(PACKS)
      ? readdirSync(PACKS).filter((name) => !name.endsWith('.json'))
      : [];
    expect(others).toEqual([]);
  });

  for (const name of files) {
    describe(name, () => {
      const bytes = new Uint8Array(readFileSync(join(PACKS, name)));
      const text = new TextDecoder().decode(bytes);
      const id = name.slice(0, -'.json'.length);

      it('passes the schema and the refinements, and is named for its id', () => {
        const loaded = loadPackBytes(bytes, {
          origin: name,
          binaryVersion: BINARY,
          expectedId: id,
        });
        if (!loaded.ok) throw new Error(`${name}: ${issuesText(loaded.error.issues)}`);
        expect(loaded.value.pack.id).toBe(id);
      });

      it('is canonical JSON', () => {
        expect(text).toBe(canonical(JSON.parse(text)));
      });

      it('registry/versions lists its current version, canonically', () => {
        const path = join(VERSIONS, name);
        const versionsText = readFileSync(path, 'utf8');
        expect(versionsText).toBe(canonical(JSON.parse(versionsText)));
        const listed = Versions.parse(JSON.parse(versionsText)).versions;
        const version = z.object({ version: z.number() }).parse(JSON.parse(text)).version;
        expect(Object.keys(listed)).toContain(String(version));
      });
    });
  }
});
