/** @module test/cli/bin-entries — `browserhive` and its `bh` shorthand are two `bin` entries for the same file (spec 08 §7, spec 06 §4) */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const Manifest = z.object({ bin: z.record(z.string(), z.string()) });
const manifest = Manifest.parse(
  JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')),
);

describe('package.json bin', () => {
  it('installs exactly browserhive and bh', () => {
    expect(Object.keys(manifest.bin).sort()).toEqual(['bh', 'browserhive']);
  });

  it('both entries point to the same file, the built bin', () => {
    expect(manifest.bin['bh']).toBe(manifest.bin['browserhive']);
    expect(manifest.bin['browserhive']).toBe('./dist/bin.js');
  });
});
