import { type SitePackView, SitePackViewResponse } from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type SitePacksAction } from '../invocation.ts';
import { printableJson } from '../output/printable.ts';
import { remoteRequest } from './admin-remote.ts';
import {
  confirmByPackId,
  fetchDetail,
  fetchDiff,
  packPath,
  pendingVersion,
  printDiff,
  provenanceText,
  type SitePacksTarget,
  sitePackCall,
  unexpected,
} from './sitepacks-common.ts';

type Of<K extends SitePacksAction['kind']> = Extract<SitePacksAction, { readonly kind: K }>;

/** Sends one action and parses `{view}`. */
async function sendAction(
  context: CommandContext,
  target: SitePacksTarget,
  request: { readonly method: string; readonly path: string; readonly body: unknown },
): Promise<SitePackView | ExitCode> {
  const result = await sitePackCall(
    context,
    target.remote,
    request.method,
    request.path,
    request.body,
  );
  if (!result.ok) return result.code;
  const parsed = SitePackViewResponse.safeParse(result.json);
  return parsed.success ? parsed.data.view : unexpected(context, 'site pack');
}

/** Prints `{view}` as JSON, or the status line. */
function done(
  context: CommandContext,
  target: SitePacksTarget,
  view: SitePackView,
  label: string,
  detail?: string,
): ExitCode {
  if (target.json) context.out.json({ view });
  else context.out.status('ok', label, detail);
  return EXIT.ok;
}

/**
 * `sitepacks apply <id> [version] [--yes]`: prints the diff, confirms, then approves the version.
 *
 * @returns 0, or 1 on a failure or refusal.
 */
export async function runSitePacksApply(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'apply'>,
): Promise<ExitCode> {
  const { packId } = action;
  const detail = await fetchDetail(context, target.remote, packId);
  if (typeof detail === 'number') return detail;
  const version = pendingVersion(context, detail.view, action.version, 'apply');
  if (version === null) return EXIT.fatal;
  const diff = await fetchDiff(context, target.remote, packId, version);
  if (typeof diff === 'number') return diff;
  if (!target.json) printDiff(context, packId, diff);
  const pending = detail.view.pending.find((p) => p.version === version);
  const from = detail.view.approved === null ? '' : ` in place of v${detail.view.approved.version}`;
  const where =
    pending === undefined ? '' : ` (${provenanceText(pending.source, pending.provenance)})`;
  const confirmed = await confirmByPackId(context, { packId, command: 'apply', yes: action.yes }, [
    `This applies v${version} of ${packId}${where}${from}.`,
    'Every template that uses the pack follows it at once; the version it replaces is kept for revert.',
  ]);
  if (confirmed !== true) return confirmed;
  const view = await sendAction(context, target, {
    method: 'POST',
    path: packPath(packId, '/apply'),
    body: { version },
  });
  if (typeof view === 'number') return view;
  return done(
    context,
    target,
    view,
    `applied v${version} of ${packId}`,
    `undo with browserhive sitepacks revert ${packId}`,
  );
}

/**
 * `sitepacks reject <id> [version]`: dismisses a pending version.
 *
 * @returns 0, or 1 on a failure.
 */
export async function runSitePacksReject(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'reject'>,
): Promise<ExitCode> {
  const { packId } = action;
  const detail = await fetchDetail(context, target.remote, packId);
  if (typeof detail === 'number') return detail;
  const version = pendingVersion(context, detail.view, action.version, 'reject');
  if (version === null) return EXIT.fatal;
  const view = await sendAction(context, target, {
    method: 'POST',
    path: packPath(packId, '/reject'),
    body: { version },
  });
  if (typeof view === 'number') return view;
  return done(
    context,
    target,
    view,
    `rejected v${version} of ${packId}`,
    'a newer version is offered again',
  );
}

/**
 * `sitepacks revert <id> [--yes]`: back to the previous approved version.
 *
 * @returns 0, or 1 on a failure or refusal.
 */
export async function runSitePacksRevert(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'revert'>,
): Promise<ExitCode> {
  const { packId } = action;
  const detail = await fetchDetail(context, target.remote, packId);
  if (typeof detail === 'number') return detail;
  const { previous, approved } = detail.view;
  if (previous === null) {
    context.out.diagnostic(`browserhive: ${packId} has no previous approved version to revert to.`);
    return EXIT.fatal;
  }
  const current = approved === null ? '' : ` from v${approved.version}`;
  const confirmed = await confirmByPackId(context, { packId, command: 'revert', yes: action.yes }, [
    `This reverts ${packId}${current} to v${previous.version} (${previous.source}).`,
    'Every template that uses the pack follows it at once.',
  ]);
  if (confirmed !== true) return confirmed;
  const view = await sendAction(context, target, {
    method: 'POST',
    path: packPath(packId, '/revert'),
    body: {},
  });
  if (typeof view === 'number') return view;
  return done(context, target, view, `reverted ${packId} to v${previous.version}`);
}

/**
 * `sitepacks approve-local <id> [--yes]`: prints the diff from the approved content to the local
 * file, then the SHA-256 it approves, confirms and approves exactly that content.
 *
 * @returns 0 (also when already approved), or 1 on a failure or refusal.
 */
export async function runSitePacksApproveLocal(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'approve-local'>,
): Promise<ExitCode> {
  const { out } = context;
  const { packId } = action;
  const detail = await fetchDetail(context, target.remote, packId);
  if (typeof detail === 'number') return detail;
  const local = detail.view.local;
  if (local === null) {
    out.diagnostic(
      `browserhive: there is no local file for ${packId} in the local folder (sitePacksDir).`,
    );
    return EXIT.fatal;
  }
  if (local.sha256 === null || local.problem !== null) {
    out.diagnostic(
      `browserhive: the local file ${local.path} cannot be approved: ${local.problem ?? 'it could not be read'}.`,
    );
    out.diagnostic('Check it with browserhive sitepacks verify <file>, fix it, then run reload.');
    return EXIT.fatal;
  }
  if (local.state === 'approved') {
    if (target.json) out.json({ view: detail.view });
    else out.status('ok', `the local file of ${packId} is already approved`, local.sha256);
    return EXIT.ok;
  }
  const diff = await fetchDiff(context, target.remote, packId, 'local');
  if (typeof diff === 'number') return diff;
  // Approve exactly the content whose difference is printed, never a hash read separately.
  const sha256 = diff.to.sha256;
  if (sha256 !== local.sha256) {
    out.diagnostic(
      `browserhive: the local file of ${packId} changed while it was read. Run approve-local again to review the new content.`,
    );
    return EXIT.fatal;
  }
  if (!target.json) {
    printDiff(context, packId, diff);
    out.line();
    out.line(`Approving the content of ${local.path}`);
    out.line(`SHA-256 ${sha256}`);
  }
  const confirmed = await confirmByPackId(
    context,
    { packId, command: 'approve-local', yes: action.yes },
    [
      'BrowserHive keeps a copy of exactly this content and applies it to every template that uses the pack.',
      'Later edits to the file change nothing until you approve them again.',
    ],
  );
  if (confirmed !== true) return confirmed;
  const answer = await remoteRequest(
    context,
    target.remote,
    'POST',
    packPath(packId, '/approve-local'),
    {
      sha256,
    },
  );
  if (!answer.ok) {
    answer.report();
    if (answer.status === 409) {
      out.diagnostic(
        'The file changed after it was shown. Run approve-local again to review the new content.',
      );
    }
    return answer.code;
  }
  const parsed = SitePackViewResponse.safeParse(printableJson(answer.json));
  if (!parsed.success) return unexpected(context, 'site pack');
  return done(context, target, parsed.data.view, `approved the local file of ${packId}`, sha256);
}

/**
 * `sitepacks pin <id> <version> | unpin <id> | follow <id> on|off|auto | enable <id> | disable <id>`.
 *
 * @returns 0, or 1 on a failure.
 */
export async function runSitePacksSetting(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'pin' | 'unpin' | 'follow' | 'enable' | 'disable'>,
): Promise<ExitCode> {
  const { packId } = action;
  switch (action.kind) {
    case 'pin': {
      const view = await sendAction(context, target, {
        method: 'PUT',
        path: packPath(packId, '/pin'),
        body: { version: action.version },
      });
      if (typeof view === 'number') return view;
      return done(context, target, view, `pinned ${packId} at v${action.version}`);
    }
    case 'unpin': {
      const view = await sendAction(context, target, {
        method: 'PUT',
        path: packPath(packId, '/pin'),
        body: { version: null },
      });
      if (typeof view === 'number') return view;
      return done(context, target, view, `unpinned ${packId}`);
    }
    case 'follow': {
      const view = await sendAction(context, target, {
        method: 'PUT',
        path: packPath(packId, '/follow'),
        body: { follow: action.follow },
      });
      if (typeof view === 'number') return view;
      const setting = action.follow === null ? 'auto' : action.follow ? 'on' : 'off';
      const now = view.follow.effective ? 'followed' : 'not followed';
      return done(context, target, view, `follow updates of ${packId}: ${setting}`, `now ${now}`);
    }
    case 'enable': {
      const view = await sendAction(context, target, {
        method: 'POST',
        path: packPath(packId, '/enable'),
        body: {},
      });
      if (typeof view === 'number') return view;
      return done(context, target, view, `enabled ${packId}`);
    }
    case 'disable':
      return runSitePacksDisable(context, target, action);
  }
}

/**
 * `sitepacks disable <id> [--yes]`: says what stops applying, confirms, then disables the pack.
 *
 * @returns 0, or 1 on a failure or refusal.
 */
async function runSitePacksDisable(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'disable'>,
): Promise<ExitCode> {
  const { packId } = action;
  const detail = await fetchDetail(context, target.remote, packId);
  if (typeof detail === 'number') return detail;
  const { view, pack } = detail;
  if (!view.enabled) {
    if (target.json) context.out.json({ view });
    else context.out.status('ok', `${packId} is already disabled`);
    return EXIT.ok;
  }
  const templates = view.used_by.length;
  const rules =
    pack === null
      ? 'its rules stop applying'
      : `its ${pack.guards.length} guard(s), ${pack.element_guards.length} element guard(s) and ${pack.challenges.length} challenge(s) stop applying`;
  const confirmed = await confirmByPackId(
    context,
    { packId, command: 'disable', yes: action.yes },
    [
      `This turns off ${view.title} (${packId}) for every template (${templates} use it): ${rules}, including its sign-out, account and credential guards.`,
      'Its sites become generic sites until you enable it again.',
    ],
  );
  if (confirmed !== true) return confirmed;
  const disabled = await sendAction(context, target, {
    method: 'POST',
    path: packPath(packId, '/disable'),
    body: {},
  });
  if (typeof disabled === 'number') return disabled;
  return done(
    context,
    target,
    disabled,
    `disabled ${packId}`,
    `enable it again with browserhive sitepacks enable ${packId}`,
  );
}
