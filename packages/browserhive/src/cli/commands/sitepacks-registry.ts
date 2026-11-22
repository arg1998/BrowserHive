/** @module cli/commands/sitepacks-registry — `browserhive sitepacks check`, `sitepacks download <id> [<version>]` and `sitepacks download --all` over a running server's REST API (spec 13 §10.4, §10.6, §11.5): Check now, Download & review with the classified diff, Download all; plus the registry status lines `check` and `list` print. */
import {
  SitePackCheckResponse,
  SitePackDownloadAllResponse,
  SitePackDownloadResponse,
  type SitePackPending,
  type SitePackRegistryStatus,
  SitePacksResponse,
  type SitePackView,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type SitePacksAction } from '../invocation.ts';
import { formatTimestamp } from './common.ts';
import { printDiff } from './sitepacks-classes.ts';
import {
  fetchDetail,
  packPath,
  packSize,
  type SitePacksTarget,
  sitePackCall,
  unexpected,
} from './sitepacks-common.ts';

type Of<K extends SitePacksAction['kind']> = Extract<SitePacksAction, { readonly kind: K }>;

/** Why no update check runs, as `check`, `list` and `doctor` word it (D-55). */
export const CHECK_OFF_TEXT: Readonly<
  Record<NonNullable<SitePackRegistryStatus['check_off']>, string>
> = {
  packs_off: 'site packs are off (sitePacks=false): no request',
  update_check_off: 'update check off (sitePacksUpdateCheck=false): no request',
  no_trust_root: 'this build pins no registry keys yet: no update check runs',
};

const ORIGIN_TEXT: Readonly<Record<NonNullable<SitePackRegistryStatus['index_origin']>, string>> = {
  registry: 'from the registry',
  import: 'imported',
  local: 'from the local folder',
};

/** `12 min ahead of`, `3 h behind`: this clock against the registry's, for the skew hints. */
export function skewText(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  const amount = minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
  // `clock_skew_ms` is the registry's `Date` minus this clock: positive means this clock is behind.
  return `${amount} ${ms > 0 ? 'behind' : 'ahead of'}`;
}

/**
 * The registry's state in a few lines: the held index, the last check, why no check runs.
 *
 * @returns The lines, unstyled.
 */
export function registryLines(status: SitePackRegistryStatus): string[] {
  const lines: string[] = [];
  if (status.check_off !== null) lines.push(`Update check: ${CHECK_OFF_TEXT[status.check_off]}`);
  else if (status.url !== null) {
    lines.push(
      `Update check: ${status.url} every 24 h (signed index only) · next ${formatTimestamp(status.next_check_at)}${status.auto_update ? ' · auto-update on' : ''}`,
    );
  }
  if (status.index_version === null) {
    lines.push('Registry index: none held yet');
  } else {
    const origin = status.index_origin === null ? '' : ` ${ORIGIN_TEXT[status.index_origin]}`;
    const signer = status.index_signed_by === null ? '' : `, signed by ${status.index_signed_by}`;
    lines.push(
      `Registry index: v${status.index_version}${origin} · ${status.index_packs} pack(s) · expires ${formatTimestamp(status.index_expires_at)}${signer}${status.stale ? ' · STALE' : ''}`,
    );
  }
  if (status.last_check_at !== null) {
    lines.push(
      `Last check: ${formatTimestamp(status.last_check_at)} (${status.last_outcome ?? '—'}) · last good ${formatTimestamp(status.last_ok_at)}`,
    );
  }
  return lines;
}

/**
 * The warnings of a registry status: stale index (with a clock hint), failed checks.
 *
 * @returns `[label, detail]` pairs.
 */
export function registryWarnings(status: SitePackRegistryStatus): [string, string][] {
  const warnings: [string, string][] = [];
  if (status.stale) {
    const clock =
      status.clock_skew_ms !== undefined && Math.abs(status.clock_skew_ms) > 3_600_000
        ? `; this machine's clock is ${skewText(status.clock_skew_ms)} the registry's: check the system clock`
        : '';
    warnings.push([
      'the held registry index expired (stale)',
      `approved packs keep applying; nothing new is offered until a fresh index verifies${clock}`,
    ]);
  }
  if (status.last_error !== null) {
    warnings.push([
      `last check failed${status.failures > 1 ? ` (${status.failures} in a row)` : ''}`,
      `[${status.last_error.code}] ${status.last_error.message}`,
    ]);
  }
  return warnings;
}

/**
 * `GET /site-packs`: the pending updates of followed packs and the local files waiting.
 *
 * @returns The catalog, or the exit code after printing the failure.
 */
async function fetchCatalog(
  context: CommandContext,
  target: SitePacksTarget,
): Promise<SitePacksResponse | ExitCode> {
  const result = await sitePackCall(context, target.remote, 'GET', '/site-packs');
  if (!result.ok) return result.code;
  const parsed = SitePacksResponse.safeParse(result.json);
  return parsed.success ? parsed.data : unexpected(context, 'site pack list');
}

/**
 * `sitepacks check`: Check now (`POST /site-packs/check`), then what waits for review.
 *
 * @returns 0; 2 when followed packs have pending updates or local files wait for approval; 1 when
 * the check failed or the server refused.
 */
export async function runSitePacksCheck(
  context: CommandContext,
  target: SitePacksTarget,
): Promise<ExitCode> {
  const { out } = context;
  const result = await sitePackCall(context, target.remote, 'POST', '/site-packs/check', {});
  if (!result.ok) return result.code;
  const parsed = SitePackCheckResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'check result');
  const check = parsed.data;
  const catalog = await fetchCatalog(context, target);
  if (typeof catalog === 'number') return catalog;
  const waiting = catalog.pending_count + catalog.local_needing_approval;
  const code: ExitCode =
    check.outcome === 'failed' ? EXIT.fatal : waiting > 0 ? EXIT.warnings : EXIT.ok;
  if (target.json) {
    out.json({
      ...check,
      pending_count: catalog.pending_count,
      local_needing_approval: catalog.local_needing_approval,
    });
    return code;
  }
  const status = check.status;
  switch (check.outcome) {
    case 'updated':
      out.status(
        'ok',
        'registry checked',
        `a new index verified (v${status.index_version ?? '?'})`,
      );
      break;
    case 'not_modified':
      out.status('ok', 'registry checked', 'no change since the last check');
      break;
    case 'failed':
      out.status(
        'fail',
        'registry check failed',
        check.error === undefined
          ? 'see the server log'
          : `[${check.error.code}] ${check.error.message}`,
      );
      break;
    case 'disabled':
      out.status(
        'warn',
        'no check made',
        status.check_off === null ? 'the update check is off' : CHECK_OFF_TEXT[status.check_off],
      );
      break;
  }
  // The outcome line already said why no check was made, or why it failed.
  const shown = check.outcome === 'failed' ? { ...status, last_error: null } : status;
  for (const line of registryLines(shown)) {
    if (check.outcome !== 'disabled' || !line.startsWith('Update check:')) out.line(`  ${line}`);
  }
  for (const [label, detail] of registryWarnings(shown)) out.status('warn', label, detail);
  // Counted from the catalog, not the check's answer: a check that made no request (or failed)
  // still knows what an earlier check or an import offered (review #100 L8).
  const waitingAll = catalog.data.reduce((n, view) => n + view.pending.length, 0);
  out.line(
    `  ${waitingAll} pending version(s) in all packs · ${catalog.pending_count} of followed packs · ${catalog.local_needing_approval} local file(s) waiting for approval`,
  );
  if (waiting > 0) out.line('  Review them: browserhive sitepacks list --pending');
  return code;
}

/** The newest pending registry version not downloaded yet. */
function availablePending(view: SitePackView): SitePackPending | undefined {
  return view.pending
    .filter((p) => p.state === 'available')
    .sort((a, b) => b.version - a.version)[0];
}

/**
 * The version `download <id>` fetches: the one asked for, else the pending available version, else
 * the newest one the index lists that this binary may use.
 *
 * @returns The version, or an exit code after printing why there is none.
 */
async function downloadVersion(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'download'>,
): Promise<{ readonly version: number } | ExitCode> {
  if (action.version !== null) return { version: action.version };
  const detail = await fetchDetail(context, target.remote, action.packId);
  if (typeof detail === 'number') return detail;
  const view = detail.view;
  const pending = availablePending(view);
  if (pending !== undefined) return { version: pending.version };
  const online = view.online;
  if (online !== null && online.usable_version !== null) return { version: online.usable_version };
  const why =
    online === null
      ? 'is not listed in the registry index this server holds (run browserhive sitepacks check first)'
      : `has no listed version this BrowserHive can use (v${online.version} needs BrowserHive ${online.needs_client ?? 'another release'})`;
  context.out.diagnostic(`browserhive: ${action.packId} ${why}.`);
  return EXIT.fatal;
}

/**
 * `sitepacks download <id> [<version>]`: Download & review. The server fetches exactly that pack
 * file, verifies it against the signed index and classifies it; the CLI prints the diff.
 *
 * @returns 0, or 1 on a failure.
 */
export async function runSitePacksDownload(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'download'>,
): Promise<ExitCode> {
  const { out } = context;
  const chosen = await downloadVersion(context, target, action);
  if (typeof chosen === 'number') return chosen;
  const { version } = chosen;
  const result = await sitePackCall(
    context,
    target.remote,
    'POST',
    packPath(action.packId, '/download'),
    { version },
  );
  if (!result.ok) return result.code;
  const parsed = SitePackDownloadResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'download result');
  if (target.json) {
    out.json(parsed.data);
    return EXIT.ok;
  }
  const { view, diff } = parsed.data;
  const row = view.pending.find((p) => p.version === version);
  const facts = [
    row?.size == null ? null : packSize(row.size),
    row?.released == null ? null : `released ${row.released}`,
    'signature and hash verified',
  ].filter((f): f is string => f !== null);
  out.status('ok', `downloaded ${view.pack_id} v${version}`, facts.join(' · '));
  if (row?.notes != null && row.notes !== '') out.line(`  Publisher's notes: ${row.notes}`);
  out.line();
  printDiff(context, view.pack_id, diff);
  out.line();
  out.line(
    `Apply it: browserhive sitepacks apply ${view.pack_id} ${version} · or reject it: browserhive sitepacks reject ${view.pack_id} ${version}`,
  );
  return EXIT.ok;
}

/**
 * `sitepacks download --all`: every listed version the server lacks, all packs (spec 13 §10.4: the
 * registry then cannot tell which pack the operator cares about).
 *
 * @returns 0; 1 when a file was refused or the server refused.
 */
export async function runSitePacksDownloadAll(
  context: CommandContext,
  target: SitePacksTarget,
): Promise<ExitCode> {
  const { out } = context;
  const result = await sitePackCall(context, target.remote, 'POST', '/site-packs/download-all', {});
  if (!result.ok) return result.code;
  const parsed = SitePackDownloadAllResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'download result');
  const answer = parsed.data;
  const code: ExitCode = answer.refused.length > 0 ? EXIT.fatal : EXIT.ok;
  if (target.json) {
    out.json(answer);
    return code;
  }
  out.status(
    answer.refused.length === 0 ? 'ok' : 'warn',
    `downloaded ${answer.downloaded.length} version(s)`,
    `${answer.held} already held · ${answer.refused.length} refused`,
  );
  for (const d of answer.downloaded) {
    out.line(`  ${out.style.dim(`${d.pack_id} v${d.version}`)} ${d.sha256}`);
  }
  for (const r of answer.refused) {
    out.status('fail', `${r.pack_id} v${r.version} refused`, `${r.reason}: ${r.detail}`);
  }
  if (answer.pending_count > 0) {
    out.line(
      `${answer.pending_count} pending update(s) of followed packs. Review them: browserhive sitepacks list --pending`,
    );
  }
  return code;
}
