/** @module cli/commands/sitepacks-layout — `browserhive sitepacks export <dir>` and `sitepacks import <dir>` for signed registry layouts (spec 13 §10.1, §10.5, §11.5): export writes the server's verified layout (`keys.json`, `index.json`, their `.sig` files, `packs/<id>/<sha256>.json`) byte for byte; import reads a layout's exact bytes (review #97 D80) and sends them, base64 by path, to be verified with the pinned keys exactly as a fetch is. */
import { Buffer } from 'node:buffer';
import { basename, join } from 'node:path';
import {
  SITE_PACK_IMPORT_MAX_BYTES,
  SITE_PACK_IMPORT_MAX_FILES,
  SitePackExportResponse,
  SitePackImportResponse,
} from '@browserhive/contracts/http';
import { PackRegistrableDomain, RegistryIndexV1 } from '@browserhive/contracts/site-packs';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type SitePacksAction } from '../invocation.ts';
import { printable } from '../output/printable.ts';
import { size } from './common.ts';
import { type SitePacksTarget, sitePackCall, unexpected } from './sitepacks-common.ts';

type Of<K extends SitePacksAction['kind']> = Extract<SitePacksAction, { readonly kind: K }>;

/** The signed top-level files of a layout, in the order they are written (signatures last). */
export const LAYOUT_TOP_FILES = ['keys.json', 'index.json', 'keys.json.sig', 'index.json.sig'];

const PACK_FILE = /^packs\/([^/]+)\/[0-9a-f]{64}\.json$/;

/** Whether `path` (relative, `/`-separated) is a file a signed layout may hold. */
export function isLayoutPath(path: string): boolean {
  if (LAYOUT_TOP_FILES.includes(path)) return true;
  const match = PACK_FILE.exec(path);
  return match !== null && PackRegistrableDomain.safeParse(match[1]).success;
}

/** Strict base64 → bytes: `null` unless re-encoding gives the same text. */
function decodeBase64(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? new Uint8Array(bytes) : null;
}

/**
 * Whether the target folder may receive an export: absent, empty, or already holding a layout.
 *
 * @returns `null` when it may, else why not.
 */
async function exportTargetProblem(context: CommandContext, dir: string): Promise<string | null> {
  const { fs } = context.deps;
  const stat = await fs.stat(dir);
  if (stat === null) return null;
  if (!stat.isDirectory) return 'exists and is not a folder.';
  const names = await fs.readdir(dir);
  if (names.length === 0 || names.includes('keys.json')) return null;
  return 'is not empty and holds no signed layout (no keys.json). Choose a new or empty folder.';
}

/**
 * `sitepacks export <dir>`: writes the verified signed layout the server holds, with every verified
 * pack file, as the registry publishes it; copy it to an offline host and `import` it there.
 *
 * @returns 0, or 1 on a failure (nothing held, an unexpected answer, a target that is not safe).
 */
export async function runSitePacksExport(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'export'>,
): Promise<ExitCode> {
  const { out, deps } = context;
  const dir = action.path;
  const refuse = (why: string): ExitCode => {
    out.diagnostic(`browserhive: ${dir} ${why}`);
    return EXIT.fatal;
  };
  const problem = await exportTargetProblem(context, dir);
  if (problem !== null) return refuse(problem);
  const result = await sitePackCall(context, target.remote, 'GET', '/site-packs/export');
  if (!result.ok) return result.code;
  const parsed = SitePackExportResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'export');
  const files = new Map<string, Uint8Array>();
  for (const [path, encoded] of Object.entries(parsed.data.files)) {
    const bytes = decodeBase64(encoded);
    if (!isLayoutPath(path) || bytes === null) {
      out.diagnostic(
        `browserhive: the server's export holds an unexpected file (${printable(path)}); nothing was written.`,
      );
      return EXIT.fatal;
    }
    files.set(path, bytes);
  }
  const missing = LAYOUT_TOP_FILES.filter((name) => !files.has(name));
  if (missing.length > 0) {
    out.diagnostic(
      `browserhive: the server's export lacks ${missing.join(', ')}; nothing was written.`,
    );
    return EXIT.fatal;
  }
  // Pack files first, the signed index and keys last: a folder cut short holds no index yet.
  const order = [
    ...[...files.keys()].filter((p) => p.startsWith('packs/')).sort(),
    ...LAYOUT_TOP_FILES,
  ];
  await deps.fs.mkdir(dir, { mode: 0o755 });
  for (const path of order) {
    const bytes = files.get(path);
    if (bytes === undefined) continue;
    const parts = path.split('/');
    if (parts.length > 1) await deps.fs.mkdir(join(dir, ...parts.slice(0, -1)), { mode: 0o755 });
    await deps.fs.writeBytes(join(dir, ...parts), bytes, { mode: 0o644 });
  }
  const packFiles = order.length - LAYOUT_TOP_FILES.length;
  if (target.json) {
    out.json({
      path: printable(dir),
      written: order,
      index_version: parsed.data.index_version,
      keys_version: parsed.data.keys_version,
      packs: parsed.data.packs,
    });
    return EXIT.ok;
  }
  out.status(
    'ok',
    `exported the signed layout to ${dir}`,
    `index v${parsed.data.index_version} · keys v${parsed.data.keys_version} · ${packFiles} pack file(s)`,
  );
  out.line(
    `  On the offline host: browserhive sitepacks import ${dir} (or copy the folder into sitePacksDir and run browserhive sitepacks reload)`,
  );
  return EXIT.ok;
}

/** What {@link readLayout} collected. */
interface CollectedLayout {
  readonly files: Record<string, string>;
  readonly bytes: number;
  /** Listed versions whose file the folder lacks. */
  readonly absent: number;
  /** Files under `packs/` the index does not list (not sent). */
  readonly ignored: number;
}

/** Every file under `<dir>/packs/<id>/`, relative and `/`-separated. */
async function packFilesIn(context: CommandContext, dir: string): Promise<string[]> {
  const { fs } = context.deps;
  const out: string[] = [];
  for (const id of await fs.readdir(join(dir, 'packs'))) {
    const stat = await fs.stat(join(dir, 'packs', id));
    if (stat?.isDirectory !== true) continue;
    for (const name of await fs.readdir(join(dir, 'packs', id))) out.push(`packs/${id}/${name}`);
  }
  return out;
}

/**
 * Reads a layout folder's exact bytes: the four signed files and every pack file the index lists.
 *
 * @returns The files (base64 by path), or why the folder cannot be sent.
 */
async function readLayout(
  context: CommandContext,
  dir: string,
): Promise<CollectedLayout | { readonly problem: string }> {
  const { fs } = context.deps;
  const files: Record<string, string> = {};
  let bytes = 0;
  const add = async (path: string): Promise<boolean> => {
    const file = join(dir, ...path.split('/'));
    const stat = await fs.stat(file);
    if (stat === null || !stat.isFile) return false;
    if (stat.sizeBytes > SITE_PACK_IMPORT_MAX_BYTES) return false;
    const data = await fs.readBytes(file);
    bytes += data.byteLength;
    files[path] = Buffer.from(data).toString('base64');
    return true;
  };
  for (const name of LAYOUT_TOP_FILES) {
    if (!(await add(name))) return { problem: `holds no readable ${name}.` };
  }
  let listed: Set<string>;
  try {
    const index = RegistryIndexV1.parse(
      JSON.parse(Buffer.from(files['index.json'] ?? '', 'base64').toString('utf8')),
    );
    listed = new Set(index.packs.flatMap((p) => p.versions.map((v) => v.path)));
  } catch {
    return { problem: 'holds an index.json that is not a registry index (schema 1).' };
  }
  let absent = 0;
  for (const path of [...listed].sort()) if (!(await add(path))) absent += 1;
  const ignored = (await packFilesIn(context, dir)).filter((p) => !listed.has(p)).length;
  return { files, bytes, absent, ignored };
}

const STATE_TEXT: Readonly<Record<string, string>> = {
  downloaded: 'queued for review (Downloaded)',
  available: 'listed, file not in the layout (Available)',
  current: 'already approved or not newer',
  refused: 'refused: the file does not match the signed index',
  other_client: 'for another BrowserHive release',
};

/**
 * `sitepacks import <dir>` with a signed layout: the folder's exact bytes, verified by the server
 * with the pinned keys exactly as a fetch is; listed versions whose file is present wait as
 * downloaded updates.
 *
 * @returns 0; 1 on a failure (not a layout, too large, refused by the server).
 */
export async function runSitePacksImportLayout(
  context: CommandContext,
  target: SitePacksTarget,
  dir: string,
): Promise<ExitCode> {
  const { out } = context;
  const refuse = (why: string): ExitCode => {
    out.diagnostic(`browserhive: ${dir} ${why}`);
    return EXIT.fatal;
  };
  const layout = await readLayout(context, dir);
  if ('problem' in layout) return refuse(layout.problem);
  const count = Object.keys(layout.files).length;
  const name = basename(dir) || dir;
  const body = { files: layout.files, name: name.slice(0, 200) };
  const bodyBytes = JSON.stringify(body).length;
  if (count > SITE_PACK_IMPORT_MAX_FILES || bodyBytes > SITE_PACK_IMPORT_MAX_BYTES) {
    return refuse(
      `holds ${count} file(s), ${size(layout.bytes)}; an import may be at most ${SITE_PACK_IMPORT_MAX_FILES} files and ${size(SITE_PACK_IMPORT_MAX_BYTES)} encoded. Copy the folder into sitePacksDir instead and run browserhive sitepacks reload.`,
    );
  }
  const result = await sitePackCall(context, target.remote, 'POST', '/site-packs/import', body);
  if (!result.ok) return result.code;
  const parsed = SitePackImportResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'import result');
  if (target.json) {
    out.json(parsed.data);
    return EXIT.ok;
  }
  const accepted = parsed.data.layout;
  out.status(
    'ok',
    `imported the signed layout ${dir}`,
    accepted === undefined
      ? `${count} file(s)`
      : `index v${accepted.index_version} (${accepted.outcome === 'updated' ? 'now held' : 'already held'}) · keys v${accepted.keys_version} · signed by ${accepted.signed_by}`,
  );
  if (layout.absent > 0)
    out.line(`  ${layout.absent} listed version(s) have no file in the folder`);
  if (layout.ignored > 0) {
    out.line(`  ${layout.ignored} file(s) under packs/ are not in the index and were not sent`);
  }
  if (parsed.data.imported.length > 0) {
    out.table(
      [{ header: 'PACK' }, { header: 'VERSION' }, { header: 'STATE' }],
      parsed.data.imported.map((item) => [
        out.style.bold(item.pack_id),
        `v${item.version}`,
        STATE_TEXT[item.state] ?? item.state,
      ]),
    );
  }
  const refused = parsed.data.imported.filter((i) => i.state === 'refused').length;
  if (refused > 0) out.status('warn', `${refused} pack file(s) refused`, 'they were not queued');
  if (parsed.data.imported.some((i) => i.state === 'downloaded')) {
    out.line('Review them: browserhive sitepacks list --pending, then sitepacks diff <pack>');
  }
  return EXIT.ok;
}
