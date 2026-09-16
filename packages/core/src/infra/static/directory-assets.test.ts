/** @module infra/static/directory-assets.test — directory index, content types, encodings, immutable prefix, missing directories. */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '../../../test/helpers/temp-dir.ts';
import { createBunStaticAssets } from './bun-static-assets.ts';
import { createDirectoryAssets } from './directory-assets.ts';
import { createTraceViewerAssets, resolveTraceViewerDir } from './playwright-trace-viewer.ts';

describe('directory assets', () => {
  it('indexes files, serves encodings and marks hashed assets immutable', async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<html></html>');
      writeFileSync(join(dir, 'assets', 'app-1.js'), 'x()');
      writeFileSync(join(dir, 'assets', 'app-1.js.br'), 'BR');
      const assets = createBunStaticAssets(dir);
      expect(assets.available).toBe(true);
      expect(await assets.indexHtml()).toBe('<html></html>');
      const js = await assets.get('assets/app-1.js');
      expect(js?.contentType).toBe('text/javascript; charset=utf-8');
      expect(js?.immutable).toBe(true);
      expect(new TextDecoder().decode(js?.encodings?.br)).toBe('BR');
      expect(await assets.get('assets/app-1.js.br')).toBeNull();
      expect(await assets.get('../etc/passwd')).toBeNull();
    });
  });

  it('a missing directory is unavailable', async () => {
    const assets = createDirectoryAssets('/definitely/not/here');
    expect(assets.available).toBe(false);
    expect(await assets.get('index.html')).toBeNull();
  });

  it('locates the Playwright trace viewer bundle', async () => {
    const dir = resolveTraceViewerDir();
    expect(dir).toBeDefined();
    const viewer = createTraceViewerAssets(dir);
    expect(viewer.available).toBe(true);
    expect((await viewer.get('index.html'))?.contentType).toBe('text/html; charset=utf-8');
  });
});
