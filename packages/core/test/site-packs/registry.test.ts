/** @module test/site-packs/registry.test — the bundled packs' source of truth, `registry/packs/<id>.json` (spec 13 §9.8, §10.7): every file passes the schema and the refinements, is named for its id, and is canonical JSON (two-space indentation and a final newline), so diffs stay stable. An empty folder passes. */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { issuesText, loadPackBytes } from '../../src/domain/site-packs/load.ts';

/** `registry/packs` at the repository root (this file lives at packages/core/test/site-packs). */
const PACKS = resolve(import.meta.dir, '..', '..', '..', '..', 'registry', 'packs');
/** The release the bundled packs target. */
const BINARY = '0.3.0';

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
        const parsed: unknown = JSON.parse(text);
        expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
      });
    });
  }
});
