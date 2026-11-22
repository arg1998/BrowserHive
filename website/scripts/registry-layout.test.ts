import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyRegistry, layoutProblem } from './registry-layout.ts';

const SHA = 'a'.repeat(64);
let dir = '';
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function layout(files: string[]): { from: string; dist: string } {
  dir = mkdtempSync(join(tmpdir(), 'bh-site-registry-'));
  const from = join(dir, 'signed');
  for (const file of files) {
    mkdirSync(join(from, file, '..'), { recursive: true });
    writeFileSync(join(from, file), file);
  }
  return { from, dist: join(dir, 'dist') };
}

const SIGNED = ['index.json', 'index.json.sig', 'keys.json', 'keys.json.sig'];

describe('the registry in the built site', () => {
  it('copies a signed layout to dist/registry/v1/', () => {
    const { from, dist } = layout([...SIGNED, `packs/linkedin.com/${SHA}.json`]);
    expect(copyRegistry(from, dist)).toBe(5);
    expect(readFileSync(join(dist, 'registry/v1/packs/linkedin.com', `${SHA}.json`), 'utf8')).toBe(
      `packs/linkedin.com/${SHA}.json`,
    );
  });

  it('copies nothing when nothing is published yet', () => {
    const { from, dist } = layout([]);
    expect(copyRegistry(from, dist)).toBe(0);
    expect(copyRegistry(join(dir, 'absent'), dist)).toBe(0);
    expect(existsSync(join(dist, 'registry'))).toBe(false);
  });

  it('refuses an unsigned layout and stray files', () => {
    expect(layoutProblem(['index.json', 'keys.json', 'keys.json.sig'])).toBe(
      'index.json.sig is missing',
    );
    expect(layoutProblem([...SIGNED, 'packs/x.com/latest.json'])).toContain('does not belong');
    expect(layoutProblem([...SIGNED, 'index.html'])).toContain('does not belong');
    const { from, dist } = layout(['index.json', `packs/x.com/${SHA}.json`]);
    expect(() => copyRegistry(from, dist)).toThrow('not a signed registry layout');
  });

  it('_headers: immutable packs, revalidated top-level files, CORS on both', () => {
    const headers = readFileSync(join(import.meta.dir, '..', 'public', '_headers'), 'utf8');
    const rule = (path: string) =>
      headers.split(/\n(?=\S)/).find((r) => r.startsWith(`${path}\n`)) ?? '';
    expect(rule('/registry/v1/packs/*')).toContain(
      'Cache-Control: public, max-age=31536000, immutable',
    );
    expect(rule('/registry/v1/:file')).toContain(
      'Cache-Control: public, max-age=0, must-revalidate',
    );
    for (const path of ['/registry/v1/packs/*', '/registry/v1/:file']) {
      expect(rule(path)).toContain('Access-Control-Allow-Origin: *');
    }
  });
});
