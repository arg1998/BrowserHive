/// <reference types="bun-types" />
/** @module contracts/test/paths.test — the reserved path prefixes and their boundaries; the subpath stays an import-free leaf the service worker can bundle (04 §18.10) */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNonSpaPath, NON_SPA_PREFIXES } from '../src/paths/index.ts';

describe('@browserhive/contracts/paths', () => {
  it('lists the four reserved prefixes', () => {
    expect([...NON_SPA_PREFIXES]).toEqual(['/api', '/mcp', '/health', '/trace-viewer']);
  });

  it('matches a prefix and what lies under it, never a longer word', () => {
    expect(isNonSpaPath('/api')).toBe(true);
    expect(isNonSpaPath('/api/v1/sessions')).toBe(true);
    expect(isNonSpaPath('/apix')).toBe(false);
    expect(isNonSpaPath('/health')).toBe(true);
    expect(isNonSpaPath('/healthz')).toBe(false);
    expect(isNonSpaPath('/trace-viewer/index.html')).toBe(true);
    expect(isNonSpaPath('/mcp')).toBe(true);
    expect(isNonSpaPath('/')).toBe(false);
    expect(isNonSpaPath('/sessions/api')).toBe(false);
    expect(isNonSpaPath('/sw.js')).toBe(false);
  });

  it('imports nothing (zod-free, platform-neutral leaf)', () => {
    const dir = join(import.meta.dir, '..', 'src', 'paths');
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), 'utf8');
      const imports = text.match(/^\s*import\b.*$/gm) ?? [];
      const reexports = [...text.matchAll(/^export [^;]*from '([^']+)'/gm)].map((m) => m[1]);
      expect({ name, imports }).toEqual({ name, imports: [] });
      for (const target of reexports) expect(target?.startsWith('./')).toBe(true);
    }
  });
});
