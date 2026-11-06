/** @module dashboard/installable-app.test — the manifest (exact members, icon files and sizes, colours, shortcut routes), the index.html links and install-offer capture, the storage keys shared with the offline page (04 §18.2–§18.4, 09 §3.5) */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPngHeader } from '../scripts/gen-app-icons.ts';
import { parseLastSeen, parseReloads } from './lib/daemon-help/keys.ts';
import { OFFLINE_CACHE_PREFIX } from './offline/page.ts';
import { THEME_COLORS } from './theme/resolve.ts';

const PACKAGE = join(import.meta.dir, '..');
const PUBLIC = join(PACKAGE, 'public');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
  icons: { src: string; sizes: string; type: string; purpose: string }[];
  shortcuts: { name: string; url: string }[];
  [key: string]: unknown;
};

/** The full paths of the route table (`FileRoutesByFullPath` in the generated route tree). */
function routePaths(): Set<string> {
  const tree = readFileSync(join(PACKAGE, 'src/routeTree.gen.ts'), 'utf8');
  const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(tree)?.[1] ?? '';
  return new Set([...block.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1] ?? ''));
}

describe('manifest.webmanifest', () => {
  it('has exactly the members of 04 §18.2', () => {
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'id',
        'name',
        'short_name',
        'description',
        'start_url',
        'scope',
        'display',
        'background_color',
        'theme_color',
        'icons',
        'shortcuts',
      ].sort(),
    );
    expect(manifest).toMatchObject({
      id: '/',
      name: 'BrowserHive',
      short_name: 'BrowserHive',
      description: 'Operator dashboard for your BrowserHive daemon.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
  });

  it('uses the light theme colour', () => {
    expect(manifest['background_color']).toBe(THEME_COLORS.light);
    expect(manifest['theme_color']).toBe(THEME_COLORS.light);
  });

  it('lists icons whose files exist with their declared PNG size', () => {
    expect(manifest.icons.map((icon) => `${icon.src} ${icon.purpose}`)).toEqual([
      '/icons/app.svg any',
      '/icons/app-192.png any',
      '/icons/app-512.png any',
      '/icons/maskable-192.png maskable',
      '/icons/maskable-512.png maskable',
    ]);
    for (const icon of manifest.icons) {
      const bytes = readFileSync(join(PUBLIC, icon.src));
      if (icon.type === 'image/svg+xml') {
        expect(icon.sizes).toBe('any');
        expect(bytes.toString('utf8')).toContain('<svg');
        continue;
      }
      expect(icon.type).toBe('image/png');
      const header = readPngHeader(bytes);
      expect(`${header?.width}x${header?.height}`).toBe(icon.sizes);
    }
    expect(readPngHeader(readFileSync(join(PUBLIC, 'icons/apple-touch-icon.png')))).toMatchObject({
      width: 180,
      height: 180,
      colorType: 2,
    });
  });

  it('has shortcuts to route-table paths', () => {
    const routes = routePaths();
    expect(routes.size).toBeGreaterThan(10);
    expect(manifest.shortcuts).toEqual([
      { name: 'Sessions', url: '/sessions' },
      { name: 'Attention', url: '/attention' },
      { name: 'Logs', url: '/logs' },
    ]);
    for (const shortcut of manifest.shortcuts) expect(routes.has(shortcut.url)).toBe(true);
  });
});

describe('index.html', () => {
  const html = readFileSync(join(PACKAGE, 'index.html'), 'utf8');

  it('links the manifest (no crossorigin) and the apple-touch-icon', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
  });

  it('captures beforeinstallprompt in the inline bootstrap, before the module graph', () => {
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(inline).toContain(
      "addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__bhInstallPrompt = e; });",
    );
    expect(html.indexOf('beforeinstallprompt')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('the capture stores the event and stops the mini-infobar', () => {
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const line = inline.split('\n').find((l) => l.includes('beforeinstallprompt')) ?? '';
    const target = new EventTarget();
    const scope = { addEventListener: target.addEventListener.bind(target) } as {
      addEventListener: EventTarget['addEventListener'];
      __bhInstallPrompt?: Event;
    };
    new Function('addEventListener', 'window', line)(scope.addEventListener, scope);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    target.dispatchEvent(event);
    expect(scope.__bhInstallPrompt).toBe(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('storage keys shared with the offline page', () => {
  it('parseLastSeen accepts a version and a timestamp only', () => {
    expect(parseLastSeen({ version: '0.3.0', seen_at: 5 })).toEqual({
      version: '0.3.0',
      seen_at: 5,
    });
    expect(parseLastSeen({ version: '0.3.0-rc.1', seen_at: 5 })).not.toBeNull();
    expect(parseLastSeen({ version: 'latest; rm -rf ~', seen_at: 5 })).toBeNull();
    expect(parseLastSeen({ version: '0.3.0', seen_at: 'x' })).toBeNull();
    expect(parseLastSeen({ version: '0.3.0' })).toBeNull();
    expect(parseLastSeen(null)).toBeNull();
    expect(parseLastSeen([])).toBeNull();
  });

  it('parseReloads keeps the numbers of an array', () => {
    expect(parseReloads([1, 'x', 2, null, Number.NaN])).toEqual([1, 2]);
    expect(parseReloads({})).toBeNull();
  });

  it('the offline page and the worker agree on the cache prefix', () => {
    // `src/sw` is its own TypeScript project (WebWorker lib), so read the constant from the source.
    const core = readFileSync(join(PACKAGE, 'src/sw/sw-core.ts'), 'utf8');
    expect(/export const CACHE_PREFIX = '([^']+)'/.exec(core)?.[1]).toBe(OFFLINE_CACHE_PREFIX);
  });
});
