/** @module scripts/snapshot-registry — the release's signed registry snapshot (spec 13 §10.9): downloads the live signed layout (`keys.json`, `keys.json.sig`, `index.json`, `index.json.sig` and every pack file the index lists) from `--url` with the registry client's request hygiene (User-Agent `BrowserHive`, no query, no cookie, no redirect, keep-alive off, timeouts, size caps while streaming), verifies it with core's `verifySignedLayout` under the root keys pinned in this build, and only then writes it to `--out` (default `packages/browserhive/dist/site-packs/registry/v1/`). Anything that does not verify fails the release with nothing written; while the build pins no root keys (before the key ceremony, D71) it refuses before any request. `bun run release:publish` runs it after `bun run build` (which recreates `dist/site-packs`) and before `package:check`.
 *
 *   bun scripts/snapshot-registry.ts [--url <https://…/registry/v1/>] [--out <dir>] [--test-root <root.pub>]…
 *
 * `--test-root` (a `{key_id, public_key}` file, as `registry-keys.mjs` writes) replaces the pinned
 * root for this script's own tests only; with it, and only with it, a loopback `http://` URL is
 * allowed (a local test server). A release never passes it.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  REGISTRY_INDEX_MAX_BYTES,
  REGISTRY_KEYS_MAX_BYTES,
  REGISTRY_SIG_MAX_BYTES,
  SITE_PACK_MAX_BYTES,
} from '@browserhive/contracts/site-packs';
import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import {
  PINNED_TRUST_ROOT,
  parseTrustRoot,
  type SignedLayoutReport,
  trustsNothing,
  verifySignedLayout,
} from '@browserhive/core/server';

const DEFAULT_URL = 'https://browserhive.ai/registry/v1/';
const DEFAULT_OUT = join(
  import.meta.dir,
  '..',
  'packages',
  'browserhive',
  'dist',
  'site-packs',
  'registry',
  'v1',
);
/** Time to response headers, then for the whole body (spec 13 §10.4). */
const HEADERS_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 30_000;

/** The chain's files and their caps (spec 13 §10.2, D-82). */
const CHAIN: readonly (readonly [string, number])[] = [
  ['keys.json', REGISTRY_KEYS_MAX_BYTES],
  ['keys.json.sig', REGISTRY_SIG_MAX_BYTES],
  ['index.json', REGISTRY_INDEX_MAX_BYTES],
  ['index.json.sig', REGISTRY_SIG_MAX_BYTES],
];

/** What the script prints and how it ends. */
export interface SnapshotResult {
  readonly code: 0 | 1 | 64;
  readonly lines: readonly string[];
}

/** The message while the build pins no root keys (consistent with `registry-trust-check.ts`). */
export const CEREMONY_MESSAGE =
  'the registry root keys are placeholders until the key ceremony (D71); a release cannot ship a verified snapshot';

class Refusal extends Error {}

function flagValues(argv: readonly string[], name: string): string[] {
  return argv.flatMap((a, i) =>
    a === name && argv[i + 1] !== undefined ? [argv[i + 1] ?? ''] : [],
  );
}

/** The test root from `--test-root` files (`{key_id, public_key}` each). */
function testRootOf(files: readonly string[]): SitePacksTrustRoot {
  const keys = files.map((file) => {
    const pub = JSON.parse(readFileSync(file, 'utf8')) as {
      key_id?: unknown;
      public_key?: unknown;
    };
    return { keyId: String(pub.key_id), publicKey: String(pub.public_key) };
  });
  const parsed = parseTrustRoot({ keys });
  if (!parsed.ok) throw new Refusal(`--test-root: ${parsed.error}`);
  return parsed.value;
}

/** `https:`, or loopback `http:` for this script's tests; ends in `/`; no query, fragment or credentials. */
function baseUrl(raw: string, test: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refusal(`--url ${raw} is not a URL`);
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!(url.protocol === 'https:' || (test && url.protocol === 'http:' && loopback))) {
    throw new Refusal(`--url must be https:// (got ${url.protocol})`);
  }
  if (
    !url.pathname.endsWith('/') ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Refusal('--url must end with / and carry no query, fragment or credentials');
  }
  return url;
}

/**
 * One GET with the client's hygiene: no cookie, no query, no redirect followed, keep-alive off,
 * 5 s to headers and 30 s in all, the body capped while it streams.
 */
async function get(url: URL, maxBytes: number): Promise<Uint8Array> {
  const total = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const headers = new AbortController();
  const timer = setTimeout(() => headers.abort(), HEADERS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'BrowserHive', accept: '*/*' },
      redirect: 'manual',
      keepalive: false,
      signal: AbortSignal.any([total, headers.signal]),
    });
  } catch (error) {
    throw new Refusal(`${url.href}: ${error instanceof Error ? error.message : 'request failed'}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Refusal(
      `${url.href} answered ${response.status}${response.status >= 300 && response.status < 400 ? ' (redirects are not followed)' : ''}`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Refusal(`${url.href} is larger than ${maxBytes} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Refusal(`${url.href} is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function refusalText(report: SignedLayoutReport): string {
  if (report.refusal !== null) {
    return `${report.refusal.file}: ${report.refusal.reason} (${report.refusal.detail})`;
  }
  return report.packs
    .filter((p) => p.status === 'absent' || p.status === 'refused')
    .map((p) => `${p.path}: ${p.status}${p.detail === null ? '' : ` (${p.detail})`}`)
    .join('; ');
}

/** `--out` may be replaced only when it is absent, empty or a layout written before. */
function prepareOut(out: string): void {
  if (!existsSync(out)) return;
  const names = readdirSync(out);
  if (names.length > 0 && !names.includes('keys.json')) {
    throw new Refusal(`${out} exists and holds no signed layout; refusing to replace it`);
  }
}

/**
 * Downloads, verifies and writes the snapshot.
 *
 * @returns The exit code and the lines to print.
 */
export async function snapshotRegistry(
  argv: readonly string[],
  now = Date.now(),
): Promise<SnapshotResult> {
  const lines: string[] = [];
  try {
    const testRoots = flagValues(argv, '--test-root');
    const test = testRoots.length > 0;
    const root = test ? testRootOf(testRoots) : PINNED_TRUST_ROOT;
    // Fail closed before any request while this build trusts no registry.
    if (trustsNothing(root)) throw new Refusal(CEREMONY_MESSAGE);
    const base = baseUrl(flagValues(argv, '--url')[0] ?? DEFAULT_URL, test);
    const out = resolve(flagValues(argv, '--out')[0] ?? DEFAULT_OUT);
    prepareOut(out);
    const files = new Map<string, Uint8Array>();
    for (const [name, cap] of CHAIN) files.set(name, await get(new URL(name, base), cap));
    const read = async (path: string, maxBytes: number) => {
      const bytes = files.get(path);
      if (bytes === undefined) return null;
      return bytes.byteLength > maxBytes ? ('too_large' as const) : bytes;
    };
    // The chain first: pack paths come from a verified index only.
    const chain = await verifySignedLayout({ read, root, now, binaryVersion: null });
    if (chain.refusal !== null || chain.index === null) {
      throw new Refusal(`the published layout does not verify: ${refusalText(chain)}`);
    }
    for (const pack of chain.index.value.packs) {
      for (const version of pack.versions) {
        files.set(version.path, await get(new URL(version.path, base), SITE_PACK_MAX_BYTES));
      }
    }
    const report = await verifySignedLayout({ read, root, now, binaryVersion: null });
    if (!report.ok)
      throw new Refusal(`the published layout does not verify: ${refusalText(report)}`);
    // Write beside the target, then swap it in: a failure leaves nothing half written.
    const staging = `${out}.partial-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    try {
      for (const [path, bytes] of files) {
        const file = join(staging, ...path.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
      rmSync(out, { recursive: true, force: true });
      mkdirSync(dirname(out), { recursive: true });
      renameSync(staging, out);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const versions = files.size - CHAIN.length;
    lines.push(
      `snapshot-registry: wrote index.json v${report.index?.value.version} (keys.json v${report.keys?.value.version}, ${versions} pack file(s), expires ${report.index?.value.expires}) from ${base.href} to ${out}`,
    );
    return { code: 0, lines };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    lines.push(`snapshot-registry: refused, nothing written: ${error.message}`);
    return { code: 1, lines };
  }
}

if (import.meta.main) {
  const result = await snapshotRegistry(process.argv.slice(2));
  for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
  process.exit(result.code);
}
