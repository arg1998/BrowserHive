/** @module contracts/test/exports.snapshot — pins the public surface of `@browserhive/contracts` and checks TSDoc on exports */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(import.meta.url), '..', '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('public surface', () => {
  it('sorted export names of src/index.ts match the snapshot', async () => {
    const names = Object.keys(await import('../src/index.ts')).sort();
    expect(names).toMatchSnapshot();
  });

  it('every file starts with a @module header', () => {
    for (const file of walk(SRC)) {
      expect(readFileSync(file, 'utf8').startsWith('/** @module ')).toBe(true);
    }
  });

  it('every exported declaration has a leading doc comment', () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith('index.ts')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/^export (const|function|class|type|interface|enum|async function) /.test(line))
          return;
        if (
          /^export function (\w+)/.test(line) &&
          lines
            .slice(Math.max(0, i - 6), i)
            .some((l) => l.startsWith(`export function ${line.split(' ')[2]?.split(/[<(]/)[0]}`))
        )
          return; // overload
        let j = i - 1;
        while (j >= 0 && lines[j]?.trim().startsWith('//')) j -= 1;
        if (!(lines[j]?.trim().endsWith('*/') ?? false))
          missing.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    expect(missing).toEqual([]);
  });
});
