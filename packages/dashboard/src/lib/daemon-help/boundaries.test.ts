/** @module lib/daemon-help/boundaries.test — `probe.ts`, `commands.ts`, `keys.ts` and `copy.ts` import only relative `.ts` files (no React, no `@/` alias, no npm package), so the offline build and the root test project can load them (04 §18.6.3, §18.10). dependency-cruiser cannot see npm imports, hence this check. */
import { describe, expect, it } from 'bun:test';

const FILES: string[] = ['probe.ts', 'commands.ts', 'keys.ts', 'copy.ts'];

async function specifiers(file: string): Promise<string[]> {
  const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+'([^']+)'/gm)].map(
    (m) => m[1] ?? '',
  );
}

describe('daemon-help boundaries', () => {
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
    expect(await specifiers('probe.ts')).toEqual(['../clock.ts']);
    expect(await specifiers('commands.ts')).toEqual(['./probe.ts']);
    expect(await specifiers('keys.ts')).toEqual([]);
    expect(await specifiers('copy.ts')).toEqual(['./probe.ts']);
  });
});
