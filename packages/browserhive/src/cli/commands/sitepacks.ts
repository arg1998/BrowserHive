/** @module cli/commands/sitepacks — `browserhive sitepacks list | show | diff` (pending versions with their classification and registry state, a pack's strategies with their parameters, the classified diff) over a running server's REST API and the dispatcher of every `sitepacks` subcommand (spec 13 §9.6, §10.4–§10.6, §11.5); the decisions are in `sitepacks-actions.ts`, the registry client's commands in `sitepacks-registry.ts` and `sitepacks-layout.ts`, the shared reads and texts in `sitepacks-common.ts`. */
import {
  type SitePackSourceKind,
  SitePacksResponse,
  type SitePackView,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation, type SitePacksAction } from '../invocation.ts';
import { formatTimestamp, size } from './common.ts';
import {
  runSitePacksApply,
  runSitePacksApproveLocal,
  runSitePacksReject,
  runSitePacksRevert,
  runSitePacksSetting,
} from './sitepacks-actions.ts';
import { CLASS_WORDS, fetchStrategies, printDiff, printStrategies } from './sitepacks-classes.ts';
import {
  fetchDetail,
  fetchDiff,
  LOCAL_TEXT,
  printPairs,
  provenanceText,
  type SitePacksTarget,
  sitePackCall,
  unexpected,
} from './sitepacks-common.ts';
import { runSitePacksExport } from './sitepacks-layout.ts';
import { runSitePacksImport, runSitePacksReload } from './sitepacks-local.ts';
import {
  registryLines,
  registryWarnings,
  runSitePacksCheck,
  runSitePacksDownload,
  runSitePacksDownloadAll,
} from './sitepacks-registry.ts';

type Of<K extends SitePacksAction['kind']> = Extract<SitePacksAction, { readonly kind: K }>;

/**
 * Runs one `sitepacks` subcommand.
 *
 * @returns The exit code.
 */
export async function runSitePacks(
  context: CommandContext,
  invocation: Extract<Invocation, { readonly command: 'sitepacks' }>,
): Promise<ExitCode> {
  const { action } = invocation;
  const target: SitePacksTarget = { remote: invocation.remote, json: invocation.json };
  switch (action.kind) {
    case 'list':
      return runSitePacksList(context, target, action);
    case 'show':
      return runSitePacksShow(context, target, action);
    case 'diff':
      return runSitePacksDiff(context, target, action);
    case 'apply':
      return runSitePacksApply(context, target, action);
    case 'reject':
      return runSitePacksReject(context, target, action);
    case 'revert':
      return runSitePacksRevert(context, target, action);
    case 'approve-local':
      return runSitePacksApproveLocal(context, target, action);
    case 'pin':
    case 'unpin':
    case 'follow':
    case 'enable':
    case 'disable':
      return runSitePacksSetting(context, target, action);
    case 'reload':
      return runSitePacksReload(context, target);
    case 'import':
      return runSitePacksImport(context, target, action);
    case 'check':
      return runSitePacksCheck(context, target);
    case 'download':
      return runSitePacksDownload(context, target, action);
    case 'download-all':
      return runSitePacksDownloadAll(context, target);
    case 'export':
      return runSitePacksExport(context, target, action);
  }
}

function approvedText(view: SitePackView): string {
  if (view.approved !== null) {
    const revoked = view.approved_revoked ? ' (revoked)' : '';
    return view.local_override
      ? `local (over v${view.approved.version})`
      : `v${view.approved.version}${revoked}`;
  }
  if (view.local_override) return 'local';
  return view.offer === null ? 'not approved' : `not approved (v${view.offer.version} offered)`;
}

/** `remote` is the online registry. */
function sourceWord(source: SitePackSourceKind): string {
  return source === 'remote' ? 'registry' : source;
}

function sourceText(view: SitePackView): string {
  if (view.local_override) return 'local';
  // Nothing approved or offered: the sources that know the pack (a registry-only pack says so).
  const source = view.approved?.source ?? view.offer?.source ?? view.sources[0];
  return source === undefined ? '—' : sourceWord(source);
}

/**
 * "v4 (relaxes rules)": pending versions with their classification (spec 13 §9.7); a registry
 * version not downloaded yet is "v5 (available)".
 */
function pendingText(view: SitePackView): string {
  const versions = view.pending
    .map((p) => {
      if (p.state === 'available') return `v${p.version} (available)`;
      const cls = p.classification;
      return cls === undefined || cls === 'unclassified'
        ? `v${p.version}`
        : `v${p.version} (${CLASS_WORDS[cls]})`;
    })
    .join(', ');
  if (view.pinned_version !== null) {
    return `pinned at v${view.pinned_version}${versions === '' ? '' : `, ${versions} available`}`;
  }
  return versions === '' ? '—' : versions;
}

function followText(view: SitePackView): string {
  const { setting, effective } = view.follow;
  return setting === 'auto' ? `auto (${effective ? 'on' : 'off'})` : setting;
}

/**
 * `sitepacks list [--source …] [--pending]`.
 *
 * @returns 0; 2 with `--pending` when an update of a followed pack or a local file waits; 1 on a failure.
 */
async function runSitePacksList(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'list'>,
): Promise<ExitCode> {
  const { out } = context;
  const query = new URLSearchParams();
  if (action.sources.length > 0) query.set('source', action.sources.join(','));
  if (action.pending) query.set('pending', 'true');
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  const result = await sitePackCall(context, target.remote, 'GET', `/site-packs${suffix}`);
  if (!result.ok) return result.code;
  const parsed = SitePacksResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'site pack list');
  const { data: packs, status, pending_count, local_needing_approval } = parsed.data;
  const waiting = pending_count + local_needing_approval;
  const code = action.pending && waiting > 0 ? EXIT.warnings : EXIT.ok;
  if (target.json) {
    out.json(parsed.data);
    return code;
  }
  if (!status.enabled) {
    out.status('warn', 'site packs are off (sitePacks=false)', 'every site is a generic site');
  }
  if (packs.length === 0) {
    out.line(action.pending ? 'Nothing waits for review.' : 'No site packs.');
  } else {
    out.table(
      [
        { header: 'PACK' },
        { header: 'APPROVED' },
        { header: 'SOURCE' },
        { header: 'LOCAL FILE' },
        { header: 'PENDING' },
        { header: 'FOLLOW' },
        { header: 'TEMPLATES' },
        { header: 'ENABLED' },
      ],
      packs.map((view) => [
        out.style.bold(view.pack_id),
        approvedText(view),
        sourceText(view),
        view.local === null ? '—' : LOCAL_TEXT[view.local.state],
        pendingText(view),
        followText(view),
        String(view.used_by.length),
        view.enabled ? 'yes' : 'no',
      ]),
    );
  }
  for (const skipped of status.skipped) {
    const version = skipped.version === null ? '' : ` v${skipped.version}`;
    out.line(
      `  ${out.style.dim(`${skipped.pack_id}${version}:`)} skipped (${skipped.source}, ${skipped.reason}) ${skipped.detail}`,
    );
  }
  out.line();
  out.line(
    `Local folder: ${status.local.dir} · ${status.local.count} file(s) · ${status.local.needing_approval} waiting for approval${status.local.signed_layouts > 0 ? ` · ${status.local.signed_layouts} signed layout(s)` : ''}`,
  );
  for (const line of registryLines(status)) out.line(line);
  for (const [label, detail] of registryWarnings(status)) out.status('warn', label, detail);
  if (waiting > 0) {
    out.status(
      'warn',
      `${pending_count} pending update(s), ${local_needing_approval} local file(s) waiting for approval`,
      'review with browserhive sitepacks diff <pack>',
    );
  }
  return code;
}

/** "v6 · 2.0 KiB · released 2026-11-20 · usable: v5": what the held registry index lists. */
function onlineText(online: NonNullable<SitePackView['online']>): string {
  const parts = [`v${online.version}`, size(online.size), `released ${online.released}`];
  if (online.revoked) parts.push('revoked');
  if (online.needs_client !== null) parts.push(`needs BrowserHive ${online.needs_client}`);
  if (online.usable_version !== online.version) {
    parts.push(
      online.usable_version === null
        ? 'no version usable by this BrowserHive'
        : `newest usable here: v${online.usable_version}`,
    );
  }
  return parts.join(' · ');
}

/** One pending version as `show` lists it: state, provenance, size, release date, notes. */
function pendingLines(view: SitePackView): string[] {
  return view.pending.map((p) => {
    const parts = [
      p.state === 'available' ? 'available (not downloaded)' : 'downloaded',
      provenanceText(p.source, p.provenance),
      p.size === null ? null : size(p.size),
      p.released === null ? null : `released ${p.released}`,
    ].filter((x): x is string => x !== null);
    const notes = p.notes === null || p.notes === '' ? '' : ` — ${p.notes}`;
    return `v${p.version}: ${parts.join(' · ')}${notes}`;
  });
}

function viewPairs(view: SitePackView): [string, string][] {
  const pairs: [string, string][] = [['domains', view.domains.join(', ')]];
  if (view.identity_provider !== null) pairs.push(['sign-in', `through ${view.identity_provider}`]);
  if (view.approved === null) {
    pairs.push(['approved', 'not approved: its sites are generic']);
  } else {
    const a = view.approved;
    const by = a.by === null ? '' : ` by ${a.by}`;
    const at = a.at === null ? '' : ` on ${formatTimestamp(a.at)}`;
    pairs.push(['approved', `v${a.version} · ${provenanceText(a.source, a.provenance)}${by}${at}`]);
    pairs.push(['sha-256', a.sha256]);
  }
  if (view.offer !== null) {
    const o = view.offer;
    pairs.push(['offered', `v${o.version} · ${provenanceText(o.source, o.provenance)}`]);
    pairs.push(['offered sha-256', o.sha256]);
  }
  if (view.approved_revoked) {
    pairs.push([
      'revoked',
      'the publisher revoked the approved version; it stays in force until you decide',
    ]);
  }
  if (view.previous !== null) {
    pairs.push(['previous', `v${view.previous.version} (${sourceWord(view.previous.source)})`]);
  }
  if (view.online !== null) pairs.push(['registry', onlineText(view.online)]);
  if (view.local !== null) {
    const local = view.local;
    pairs.push(['local file', `${local.path} · ${LOCAL_TEXT[local.state]}`]);
    if (local.sha256 !== null) pairs.push(['local sha-256', local.sha256]);
    if (local.problem !== null) pairs.push(['local problem', local.problem]);
  }
  pairs.push(['pending', pendingText(view)]);
  for (const line of pendingLines(view)) pairs.push(['', line]);
  pairs.push(['follow', followText(view)]);
  pairs.push(['enabled', view.enabled ? 'yes' : 'no']);
  pairs.push(['templates', view.used_by.length === 0 ? 'none' : view.used_by.join(', ')]);
  pairs.push([
    'write policy',
    `${view.write_policy_default} by default · terms: ${view.stance.replace('_', ' ')}`,
  ]);
  if (view.human_only) pairs.push(['sign-in by', 'a person only (never filled by the vault)']);
  if (view.skipped !== undefined) {
    const s = view.skipped;
    const version = s.version === null ? '' : `v${s.version} `;
    pairs.push(['skipped', `${version}${s.reason}: ${s.detail}`]);
  }
  return pairs;
}

/**
 * `sitepacks show <id>`.
 *
 * @returns 0, or 1 on a failure.
 */
async function runSitePacksShow(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'show'>,
): Promise<ExitCode> {
  const { out } = context;
  const detail = await fetchDetail(context, target.remote, action.packId);
  if (typeof detail === 'number') return detail;
  if (target.json) {
    out.json(detail);
    return EXIT.ok;
  }
  const { view, pack } = detail;
  const strategies =
    pack === null || pack.strategies.length === 0
      ? null
      : await fetchStrategies(context, target.remote);
  out.line(`${out.style.bold(view.title)} (${view.pack_id})`);
  printPairs(context, viewPairs(view));
  if (pack !== null) {
    out.line();
    const counts = `${pack.guards.length} guard(s) · ${pack.element_guards.length} element guard(s) · ${pack.challenges.length} challenge(s) · ${pack.strategies.length} strategy(ies)`;
    out.line(`Rules: ${counts}`);
    const clause = pack.write_policy.clause;
    if (clause !== undefined) {
      out.line(`Terms (checked ${clause.checked}, ${clause.url}):`);
      out.line(`  "${clause.quote}"`);
    }
    if (pack.write_policy.exception !== undefined) {
      out.line(`Exception to the stance rule: ${pack.write_policy.exception}`);
    }
    const verified = Object.entries(pack.verified);
    if (verified.length > 0) {
      out.line(`Verified: ${verified.map(([field, date]) => `${field} ${date}`).join(', ')}`);
    }
    printStrategies(context, pack, strategies);
  }
  if (detail.versions.length > 0) {
    out.line();
    out.table(
      [{ header: 'VERSION' }, { header: 'SOURCE' }, { header: 'STATE' }, { header: 'SHA-256' }],
      detail.versions.map((v) => [
        v.version === null ? 'local' : `v${v.version}`,
        sourceWord(v.source),
        v.state,
        v.sha256,
      ]),
    );
  }
  return EXIT.ok;
}

/**
 * `sitepacks diff <id> [--to <version|local>]`.
 *
 * @returns 0, or 1 on a failure (no candidate, several candidates, an API error).
 */
async function runSitePacksDiff(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'diff'>,
): Promise<ExitCode> {
  let to = action.to;
  if (to === null) {
    const detail = await fetchDetail(context, target.remote, action.packId);
    if (typeof detail === 'number') return detail;
    const candidates: (number | 'local')[] = detail.view.pending.map((p) => p.version);
    const local = detail.view.local;
    if (local !== null && local.state !== 'approved' && local.sha256 !== null) {
      candidates.push('local');
    }
    const only = candidates[0];
    if (only === undefined || candidates.length > 1) {
      context.out.diagnostic(
        only === undefined
          ? `browserhive: ${action.packId} has no pending version and no local file waiting for approval.`
          : `browserhive: ${action.packId} has several candidates (${candidates.map((c) => (c === 'local' ? 'local' : `v${c}`)).join(', ')}); pass --to <version|local>.`,
      );
      return EXIT.fatal;
    }
    to = only;
  }
  const diff = await fetchDiff(context, target.remote, action.packId, to);
  if (typeof diff === 'number') return diff;
  if (target.json) context.out.json(diff);
  else printDiff(context, action.packId, diff);
  return EXIT.ok;
}
