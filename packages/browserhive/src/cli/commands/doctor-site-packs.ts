/** @module cli/commands/doctor-site-packs — the `site packs` row of `browserhive doctor` (spec 13 §11.9; always shown): ✓ the bundled packs and the release's registry snapshot verify, with the update check's disclosure (D-55); ! local files not yet approved or changed since approval, local files that fail validation, no bundled packs, a stale registry index, repeated failed checks, a clock far from the registry's; ✗ a bundled pack or the snapshot does not verify. Packs that need a newer BrowserHive are counted, never a problem. Reads through the injected filesystem and a read-only, never-migrating database read. */
import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import { SITE_PACK_MAX_BYTES } from '@browserhive/contracts/site-packs';
import type { SourcePackVersion } from '@browserhive/core/ports/site-packs';
import { BundledIndex, loadPackBytes, sha256Hex } from '@browserhive/core/server';
import type { CliDeps } from '../deps.ts';
import { databasePath } from './common.ts';
import type { CheckResult } from './doctor-checks.ts';
import { registryFacts } from './doctor-site-pack-registry.ts';
import { resolvedProblems } from './doctor-site-pack-state.ts';

const CHECK = 'site packs';
/** Entries a detail names before "and N more". */
const LIST_MAX = 3;
/** Top-level files of a signed layout (read by the server at boot and on reload). */
const LAYOUT_FILES: ReadonlySet<string> = new Set([
  'keys.json',
  'keys.json.sig',
  'index.json',
  'index.json.sig',
]);

/** What the check needs besides the deps. */
export interface SitePackCheckInput {
  readonly dataDir: string;
  /** The resolved configuration, `null` when it does not resolve. */
  readonly config: ServerConfig | null;
  /** The bundled packs' folder (`dist/site-packs` or `registry/packs`), `undefined` when none. */
  readonly bundledDir: string | undefined;
  /** This binary's version (`min_client`/`max_client`). */
  readonly binaryVersion: string;
}

type Deps = Pick<CliDeps, 'fs' | 'openStorage' | 'clock' | 'sitePacksTrustRoot'>;

/** One file checked. */
type Checked =
  | {
      readonly kind: 'ok';
      readonly id: string;
      readonly sha256: string;
      readonly version: SourcePackVersion;
    }
  | { readonly kind: 'newer'; readonly id: string }
  | { readonly kind: 'bad'; readonly id: string; readonly detail: string };

function listText(items: readonly string[]): string {
  const shown = items.slice(0, LIST_MAX).join(', ');
  return items.length > LIST_MAX ? `${shown} and ${items.length - LIST_MAX} more` : shown;
}

async function checkFile(
  deps: Deps,
  path: string,
  id: string,
  binaryVersion: string,
  expected?: { readonly sha256: string; readonly size: number },
): Promise<Checked> {
  const stat = await deps.fs.stat(path).catch(() => null);
  if (stat === null || !stat.isFile) return { kind: 'bad', id, detail: 'missing' };
  if (stat.sizeBytes > SITE_PACK_MAX_BYTES) return { kind: 'bad', id, detail: 'too large' };
  let text: string;
  try {
    text = await deps.fs.readFile(path);
  } catch {
    return { kind: 'bad', id, detail: 'unreadable' };
  }
  const bytes = new TextEncoder().encode(text);
  if (
    expected !== undefined &&
    (sha256Hex(bytes) !== expected.sha256 || bytes.byteLength !== expected.size)
  ) {
    return { kind: 'bad', id, detail: 'hash mismatch' };
  }
  const loaded = loadPackBytes(bytes, {
    origin: path,
    binaryVersion,
    expectedId: id,
  });
  if (!loaded.ok) {
    return loaded.error.reason === 'min_client'
      ? { kind: 'newer', id }
      : { kind: 'bad', id, detail: loaded.error.reason };
  }
  return { kind: 'ok', id, sha256: loaded.value.sha256, version: loaded.value };
}

async function jsonNames(deps: Deps, dir: string): Promise<readonly string[]> {
  return (await deps.fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
}

/** The bundled packs: through the build's `index.json`, else every `<id>.json` of the folder. */
async function checkBundled(deps: Deps, dir: string, binary: string): Promise<readonly Checked[]> {
  const indexPath = join(dir, 'index.json');
  if ((await deps.fs.stat(indexPath)) !== null) {
    let parsed: BundledIndex;
    try {
      parsed = BundledIndex.parse(JSON.parse(await deps.fs.readFile(indexPath)));
    } catch {
      return [{ kind: 'bad', id: 'index.json', detail: 'not a bundled pack index' }];
    }
    const out: Checked[] = [];
    for (const entry of parsed.packs) {
      out.push(await checkFile(deps, join(dir, entry.path), entry.id, binary, entry));
    }
    return out;
  }
  const out: Checked[] = [];
  for (const name of await jsonNames(deps, dir)) {
    out.push(await checkFile(deps, join(dir, name), name.slice(0, -'.json'.length), binary));
  }
  return out;
}

type States = Awaited<ReturnType<Awaited<ReturnType<Deps['openStorage']>>['sitePackStates']>>;

/** What the row reads from the database: the approvals and the registry client's status row. */
interface Stored {
  readonly states: States;
  readonly client: string | null;
}

const NOTHING_STORED: Stored = { states: { rows: [], unreadable: [] }, client: null };

async function stored(deps: Deps, dataDir: string): Promise<Stored> {
  if ((await deps.fs.stat(databasePath(dataDir))) === null) return NOTHING_STORED;
  try {
    const storage = await deps.openStorage({
      dataDir,
      readOnly: true,
      migrate: false,
      owner: 'doctor',
    });
    try {
      const states = await storage.sitePackStates();
      const client = await storage.metaValue('site_packs.client').catch(() => null);
      return { states, client };
    } finally {
      await storage.close();
    }
  } catch {
    // The database row reports a database that cannot be opened.
    return NOTHING_STORED;
  }
}

/**
 * The `site packs` row.
 *
 * @returns The result.
 */
export async function checkSitePacks(deps: Deps, input: SitePackCheckInput): Promise<CheckResult> {
  if (input.config?.sitePacks === false) {
    return {
      check: CHECK,
      status: 'ok',
      detail: 'off (sitePacks=false): template sites are generic',
    };
  }
  const warnings: string[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  // Bundled packs.
  const bundledDir = input.bundledDir;
  const bundledOk: SourcePackVersion[] = [];
  const localOk: SourcePackVersion[] = [];
  if (bundledDir === undefined || (await deps.fs.stat(bundledDir)) === null) {
    warnings.push('no bundled site packs found (the installation is incomplete; reinstall)');
  } else {
    const bundled = await checkBundled(deps, bundledDir, input.binaryVersion);
    const bad = bundled.flatMap((c) => (c.kind === 'bad' ? [`${c.id} (${c.detail})`] : []));
    if (bad.length > 0) failures.push(`bundled packs do not verify: ${listText(bad)}`);
    for (const c of bundled) if (c.kind === 'ok') bundledOk.push(c.version);
    const ok = bundledOk.length;
    const newer = bundled.filter((c) => c.kind === 'newer').length;
    notes.push(
      `${ok} bundled pack${ok === 1 ? '' : 's'}${newer > 0 ? ` (${newer} need a newer BrowserHive)` : ''}`,
    );
  }
  // Local files.
  const localDir = input.config?.sitePacksDir ?? join(input.dataDir, 'site-packs', 'local');
  const names = await deps.fs.readdir(localDir).catch(() => []);
  const fromDb = await stored(deps, input.dataDir);
  const states = fromDb.states;
  const approvals = new Map(
    states.rows.flatMap((r) =>
      r.localApprovedSha256 === null ? [] : [[r.packId, r.localApprovedSha256] as const],
    ),
  );
  const notApproved: string[] = [];
  const changed: string[] = [];
  const invalid: string[] = [];
  let layouts = names.some((n) => LAYOUT_FILES.has(n)) ? 1 : 0;
  let approved = 0;
  for (const name of [...names].sort()) {
    if (name.startsWith('.') || LAYOUT_FILES.has(name)) continue;
    const path = join(localDir, name);
    const stat = await deps.fs.stat(path).catch(() => null);
    if (stat?.isDirectory === true) {
      if (!(layouts > 0 && name === 'packs')) layouts += 1;
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const checked = await checkFile(
      deps,
      path,
      name.slice(0, -'.json'.length),
      input.binaryVersion,
    );
    if (checked.kind !== 'ok') {
      invalid.push(checked.kind === 'bad' ? `${checked.id} (${checked.detail})` : checked.id);
      continue;
    }
    localOk.push(checked.version);
    const sha = approvals.get(checked.id);
    if (sha === undefined) notApproved.push(checked.id);
    else if (sha !== checked.sha256) changed.push(checked.id);
    else approved += 1;
  }
  if (notApproved.length > 0) {
    warnings.push(`local files not yet approved: ${listText(notApproved)}`);
  }
  if (changed.length > 0) warnings.push(`local files changed since approval: ${listText(changed)}`);
  if (invalid.length > 0) warnings.push(`local files skipped: ${listText(invalid)}`);
  if (layouts > 0) {
    notes.push(`${layouts} signed layout${layouts === 1 ? '' : 's'} in the local folder`);
  }
  // Approved packs that do not apply after all (review #83 S-M8, C-M5).
  const notInForce = await resolvedProblems(deps, {
    dataDir: input.dataDir,
    localDir,
    binaryVersion: input.binaryVersion,
    bundled: bundledOk,
    local: localOk,
    states: states.rows,
    unreadable: states.unreadable,
  });
  if (notInForce.length > 0) warnings.push(`packs not in force: ${listText(notInForce)}`);
  if (approved > 0) notes.push(`${approved} approved local file${approved === 1 ? '' : 's'}`);
  // The registry: the update check's disclosure, the held index, the client's checks, the snapshot.
  const registry = await registryFacts(deps, {
    dataDir: input.dataDir,
    config: input.config,
    bundledDir,
    binaryVersion: input.binaryVersion,
    client: fromDb.client,
  });
  notes.push(...registry.notes);
  warnings.push(...registry.warnings);
  failures.push(...registry.failures);
  if (failures.length > 0) {
    return { check: CHECK, status: 'fail', detail: [...failures, ...warnings].join('; ') };
  }
  if (warnings.length > 0) {
    return {
      check: CHECK,
      status: 'warn',
      detail: `${warnings.join('; ')}; review them on the Site packs page`,
    };
  }
  return { check: CHECK, status: 'ok', detail: notes.join(', ') };
}
