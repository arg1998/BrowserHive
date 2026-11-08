/** @module dashboard/scripts/offline-sw-plugin — the `vite build` plugin that adds the installable
 * app's offline page and service worker to the bundle (04 §18.5.6). In `generateBundle` it builds
 * `offline.html` in its own isolated build (two entries of one build would share chunks), emits
 * every file of it, builds `src/sw/sw.ts` into a classic IIFE `sw.js` with the precache list and
 * its version injected, and writes `sw-precache.json`. It never imports a bare `rolldown`: the
 * hoisted copy differs from the one inside Vite.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { build, type Plugin, type Rolldown } from 'vite';

/** The precache may not exceed this many bytes, uncompressed (04 §18.5.6). */
export const PRECACHE_BUDGET_BYTES = 300 * 1024;

/** `NAVIGATION_TIMEOUT_MS` (04 §18.5.1). */
export const NAVIGATION_TIMEOUT_MS = 10_000;

/** `MARKER_HEADER`: the daemon's version marker (03 §2), lower case. */
export const MARKER_HEADER = 'x-browserhive-version';

/** The offline page, in the bundle and in the precache. */
export const OFFLINE_HTML = 'offline.html';

/** Plugin options. */
export interface OfflineSwPluginOptions {
  /** The dashboard package directory. */
  readonly root: string;
  /**
   * `offline` (default) builds `src/sw/sw.ts`; `kill-switch` builds `src/sw/kill-switch.ts` in its
   * place, the release that removes a misbehaving worker (04 §18.5.7).
   */
  readonly worker?: 'offline' | 'kill-switch';
}

/** One file of the isolated offline build. */
export interface BuiltFile {
  readonly fileName: string;
  readonly source: string | Uint8Array;
}

function outputsOf(result: Awaited<ReturnType<typeof build>>): BuiltFile[] {
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  return outputs.flatMap((output) =>
    output.output.map((file) => ({
      fileName: file.fileName,
      source: file.type === 'chunk' ? file.code : file.source,
    })),
  );
}

function byteLength(source: string | Uint8Array): number {
  return typeof source === 'string' ? Buffer.byteLength(source) : source.byteLength;
}

/**
 * `SW_VERSION`: the first 12 hex characters of the SHA-256 over the sorted precache paths and
 * their bytes, so any change to the offline page or its assets changes `sw.js`.
 */
export function precacheVersion(files: readonly BuiltFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    hash.update(`/${file.fileName}\n`);
    hash.update(file.source);
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 12);
}

/** The precache list: `/offline.html` first, then the hashed files, sorted. */
export function precachePaths(files: readonly BuiltFile[]): string[] {
  const rest = files
    .map((file) => file.fileName)
    .filter((name) => name !== OFFLINE_HTML)
    .sort();
  return [`/${OFFLINE_HTML}`, ...rest.map((name) => `/${name}`)];
}

/** Problems with the offline build's files against the main bundle (empty when it may ship). */
export function precacheProblems(
  files: readonly BuiltFile[],
  mainBundle: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  if (!files.some((file) => file.fileName === OFFLINE_HTML)) {
    problems.push(`the offline build has no ${OFFLINE_HTML}`);
  }
  for (const file of files) {
    if (mainBundle.has(file.fileName)) {
      problems.push(`precache path /${file.fileName} collides with a main-bundle file`);
    }
  }
  const total = files.reduce((sum, file) => sum + byteLength(file.source), 0);
  if (total > PRECACHE_BUDGET_BYTES) {
    problems.push(`the precache is ${total} bytes; the budget is ${PRECACHE_BUDGET_BYTES}`);
  }
  return problems;
}

/** Builds `offline.html` on its own: nothing it shares with the dashboard becomes a shared chunk. */
async function buildOfflinePage(root: string): Promise<BuiltFile[]> {
  const result = await build({
    configFile: false,
    root,
    mode: 'production',
    logLevel: 'warn',
    publicDir: false,
    envFile: false,
    resolve: { alias: { '@': join(root, 'src') } },
    plugins: [tailwindcss()],
    build: {
      write: false,
      emptyOutDir: false,
      sourcemap: false,
      // A data: font would be blocked by the CSP's font-src ('self'); keep every asset a file.
      assetsInlineLimit: 0,
      rolldownOptions: {
        input: join(root, OFFLINE_HTML),
        output: {
          entryFileNames: 'assets/offline-[hash].js',
          chunkFileNames: 'assets/offline-[name]-[hash].js',
          assetFileNames: 'assets/offline-[name]-[hash][extname]',
        },
      },
    },
  });
  return outputsOf(result);
}

/** Builds the worker into one minified classic script. */
async function buildWorker(
  root: string,
  entry: string,
  version: string,
  paths: readonly string[],
): Promise<string> {
  const result = await build({
    configFile: false,
    root,
    mode: 'production',
    logLevel: 'warn',
    publicDir: false,
    envFile: false,
    define: {
      SW_VERSION: JSON.stringify(version),
      SW_PRECACHE: JSON.stringify(paths),
      NAVIGATION_TIMEOUT_MS: String(NAVIGATION_TIMEOUT_MS),
      MARKER_HEADER: JSON.stringify(MARKER_HEADER),
    },
    build: {
      write: false,
      emptyOutDir: false,
      sourcemap: false,
      minify: true,
      lib: {
        entry: join(root, entry),
        formats: ['iife'],
        name: 'browserhiveWorker',
        fileName: () => 'sw.js',
      },
    },
  });
  const files = outputsOf(result);
  const script = files.find((file) => file.fileName === 'sw.js');
  if (script === undefined || typeof script.source !== 'string') {
    throw new Error(`the worker build of ${entry} produced no sw.js`);
  }
  return script.source;
}

/** Problems with the built worker script (empty when it may ship). */
export function workerProblems(script: string, version: string): string[] {
  const problems: string[] = [];
  if (/\bimportScripts\b/.test(script)) problems.push('sw.js calls importScripts');
  if (/\bimport\b/.test(script)) problems.push('sw.js contains an import');
  if (/zod/i.test(script)) problems.push('sw.js bundles zod');
  if (!script.includes(version)) problems.push(`sw.js lacks its version ${version}`);
  return problems;
}

/** The plugin (04 §18.5.6). Active only in `vite build`. */
export function offlineSwPlugin(options: OfflineSwPluginOptions): Plugin {
  const worker = options.worker ?? 'offline';
  return {
    name: 'browserhive:offline-sw',
    apply: 'build',
    async generateBundle(_output, bundle) {
      const files = await buildOfflinePage(options.root);
      const problems = precacheProblems(files, new Set(Object.keys(bundle)));
      if (problems.length > 0) this.error(`offline page: ${problems.join('; ')}`);
      for (const file of files) {
        this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source });
      }
      const version = precacheVersion(files);
      const paths = precachePaths(files);
      const entry = worker === 'kill-switch' ? 'src/sw/kill-switch.ts' : 'src/sw/sw.ts';
      const script = await buildWorker(options.root, entry, version, paths);
      // The kill switch has no precache to name; it only has to be free of imports.
      const scriptProblems = workerProblems(script, version).filter(
        (problem) => worker === 'offline' || !problem.includes('lacks its version'),
      );
      if (scriptProblems.length > 0) this.error(`service worker: ${scriptProblems.join('; ')}`);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: script });
      this.emitFile({
        type: 'asset',
        fileName: 'sw-precache.json',
        source: `${JSON.stringify({ version, paths }, null, 2)}\n`,
      });
    },
  };
}
