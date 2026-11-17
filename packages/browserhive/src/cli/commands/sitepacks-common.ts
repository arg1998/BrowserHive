/** @module cli/commands/sitepacks-common — what the `sitepacks` subcommands share: the pack and diff reads, the provenance and local-file texts, the field diff printer, the typed-id confirmation and the choice of the pending version (spec 13 §10.5, §10.6, §11.5) */
import {
  SitePackDetailResponse,
  SitePackDiffResponse,
  type SitePackLocalState,
  type SitePackProvenance,
  type SitePackSourceKind,
  type SitePackView,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type RemoteTarget } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';

/** The server and output mode of one `sitepacks` run. */
export interface SitePacksTarget {
  readonly remote: RemoteTarget;
  readonly json: boolean;
}

/** A local file's state as the dashboard words it (spec 13 §10.5). */
export const LOCAL_TEXT: Readonly<Record<SitePackLocalState, string>> = {
  approved: 'approved',
  changed: 'changed since approval — review',
  not_approved: 'not yet approved',
};

/**
 * Prints that the server's answer did not parse.
 *
 * @returns 1.
 */
export function unexpected(context: CommandContext, what: string): ExitCode {
  context.out.diagnostic(`browserhive: the server answered with an unexpected ${what}.`);
  return EXIT.fatal;
}

/**
 * `/site-packs/<id>` with the id encoded.
 *
 * @returns The API path.
 */
export function packPath(packId: string, tail = ''): string {
  return `/site-packs/${encodeURIComponent(packId)}${tail}`;
}

/**
 * Where a version came from, as shown at approval: "bundled with BrowserHive 0.3.0", a local file's
 * path, an imported file's name, or (T4b) the registry's signing key and index.
 *
 * @returns The text.
 */
export function provenanceText(
  source: SitePackSourceKind,
  provenance: SitePackProvenance | null,
): string {
  if (provenance === null) return source;
  switch (provenance.kind) {
    case 'bundled':
      return `bundled with BrowserHive ${provenance.release}`;
    case 'remote':
      return `registry (key ${provenance.key_id}, index ${provenance.index_version}, signature verified)`;
    case 'import':
      return `imported file ${provenance.file}`;
    case 'local':
      return `local file ${provenance.path}`;
  }
}

/**
 * `GET /site-packs/{id}`.
 *
 * @returns The detail, or an exit code after printing the failure.
 */
export async function fetchDetail(
  context: CommandContext,
  remote: RemoteTarget,
  packId: string,
): Promise<SitePackDetailResponse | ExitCode> {
  const result = await remoteCall(context, remote, 'GET', packPath(packId));
  if (!result.ok) return result.code;
  const parsed = SitePackDetailResponse.safeParse(result.json);
  return parsed.success ? parsed.data : unexpected(context, 'site pack');
}

/**
 * `GET /site-packs/{id}/diff?to=…` from the approved version.
 *
 * @returns The diff, or an exit code after printing the failure.
 */
export async function fetchDiff(
  context: CommandContext,
  remote: RemoteTarget,
  packId: string,
  to: number | 'local',
): Promise<SitePackDiffResponse | ExitCode> {
  const result = await remoteCall(context, remote, 'GET', packPath(packId, `/diff?to=${to}`));
  if (!result.ok) return result.code;
  const parsed = SitePackDiffResponse.safeParse(result.json);
  return parsed.success ? parsed.data : unexpected(context, 'diff');
}

function refText(ref: SitePackDiffResponse['to']): string {
  return `${ref.version === null ? 'local file' : `v${ref.version}`} (${ref.source}, sha-256 ${ref.sha256.slice(0, 12)}…)`;
}

/** A JSON value on one line, at most 160 characters. */
function valueText(value: unknown): string {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** Prints a field-level diff: the two versions, new domains, then one line per changed field. */
export function printDiff(
  context: CommandContext,
  packId: string,
  diff: SitePackDiffResponse,
): void {
  const { out } = context;
  const from = diff.from === null ? 'nothing approved' : refText(diff.from);
  out.line(`${out.style.bold(packId)}: ${from} → ${refText(diff.to)}`);
  if (diff.classification !== 'unclassified') out.line(`Change: ${diff.classification}`);
  if (diff.new_domains.length > 0) {
    out.status(
      'warn',
      `adds domain(s) ${diff.new_domains.join(', ')}`,
      "the pack's rules would apply there too",
    );
  }
  if (diff.changes.length === 0) {
    out.line('No field changes.');
    return;
  }
  for (const change of diff.changes) {
    const tag = change.class === null ? '' : ` ${out.style.dim(`[${change.class}]`)}`;
    out.line(`  ${change.path}${tag}`);
    out.line(`    ${out.style.red(`- ${valueText(change.from)}`)}`);
    out.line(`    ${out.style.green(`+ ${valueText(change.to)}`)}`);
  }
  out.line(`${diff.changes.length} field(s) changed.`);
}

/** Prints `label  value` pairs aligned on the label. */
export function printPairs(context: CommandContext, pairs: readonly [string, string][]): void {
  const width = Math.max(...pairs.map(([label]) => label.length));
  for (const [label, value] of pairs) {
    context.out.line(`  ${context.out.style.dim(label.padEnd(width))}  ${value}`);
  }
}

/**
 * The confirmation of `apply`, `revert` and `approve-local`: on a terminal the operator types the
 * pack id; without one the command refuses unless `--yes` (spec 13 §11.5).
 *
 * @returns `true` to go ahead, else 1 after printing why not.
 */
export async function confirmByPackId(
  context: CommandContext,
  input: { readonly packId: string; readonly command: string; readonly yes: boolean },
  explain: readonly string[],
): Promise<true | ExitCode> {
  const { out, deps } = context;
  if (input.yes) return true;
  if (deps.prompt === null) {
    out.diagnostic(
      `browserhive sitepacks ${input.command}: refusing without confirmation, and stdin is not a terminal.`,
    );
    out.diagnostic('Run it in a terminal, or pass --yes if you are scripting this deliberately.');
    return EXIT.fatal;
  }
  out.lines(explain);
  const answer = await deps.prompt(`Type the pack id (${input.packId}) to confirm: `);
  if (answer.trim().toLowerCase() === input.packId) return true;
  out.line('Aborted — nothing was changed.');
  return EXIT.fatal;
}

/**
 * The version `apply` or `reject` acts on: the one asked for (it must be pending), else the only
 * pending version.
 *
 * @returns The version, or `null` after printing why there is none.
 */
export function pendingVersion(
  context: CommandContext,
  view: SitePackView,
  requested: number | null,
  command: string,
): number | null {
  const versions = view.pending.map((p) => p.version);
  if (requested !== null) {
    if (versions.includes(requested)) return requested;
    context.out.diagnostic(
      `browserhive: v${requested} of ${view.pack_id} is not pending.${versions.length === 0 ? '' : ` Pending: ${versions.map((v) => `v${v}`).join(', ')}.`}`,
    );
    return null;
  }
  const only = versions[0];
  if (only !== undefined && versions.length === 1) return only;
  context.out.diagnostic(
    only === undefined
      ? `browserhive: ${view.pack_id} has no pending version.`
      : `browserhive: ${view.pack_id} has several pending versions (${versions.map((v) => `v${v}`).join(', ')}); pass the one to ${command}: browserhive sitepacks ${command} ${view.pack_id} <version>.`,
  );
  return null;
}
