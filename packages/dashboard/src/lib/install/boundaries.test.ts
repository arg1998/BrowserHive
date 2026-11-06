/** @module lib/install/boundaries.test — `support.ts` and `steps.ts` import only relative `.ts` files (no React, no `@/` alias, no npm package), like `lib/daemon-help` (04 §18.10). dependency-cruiser cannot see npm imports, hence this check. */
import { describe, expect, it } from 'bun:test';

const FILES: string[] = ['support.ts', 'steps.ts'];

async function specifiers(file: string): Promise<string[]> {
  const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+'([^']+)'/gm)].map(
    (m) => m[1] ?? '',
  );
}

describe('install boundaries', () => {
  it.each(FILES)('%s imports only relative .ts modules', async (file) => {
    for (const specifier of await specifiers(file)) {
      expect({ file, specifier, ok: /^\.\.?\/[^@]*\.ts$/.test(specifier) }).toEqual({
        file,
        specifier,
        ok: true,
      });
    }
  });

  it('the check sees the imports that exist', async () => {
    expect(await specifiers('support.ts')).toEqual([]);
    expect(await specifiers('steps.ts')).toEqual([]);
  });
});
