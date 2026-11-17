/** @module features/templates/relogin-text — the words of health and re-login (spec 13 §8): where a re-login stands, why one failed, why a linked vault binding would refuse the template's fill (computed from the binding until the server's answer arrives), and the probe outcomes and triggers of the Activity tab */
import {
  NotificationChannelKind,
  type TemplateProbeTrigger,
  type TemplateReloginState,
} from '@browserhive/contracts/enums';
import type { BindingProblem, ReloginView, VaultBinding } from '@browserhive/contracts/http';
import { PLATFORMS } from '@/features/notifications/channels/platforms.tsx';

/** A re-login that is still going (a window queued or open, or a fill running). */
export function reloginActive(relogin: ReloginView | null): relogin is ReloginView {
  return relogin !== null && ['queued', 'open', 'filling'].includes(relogin.state);
}

/** A re-login whose window is queued or open: **Show window** applies. */
export function reloginWindowPending(relogin: ReloginView | null): boolean {
  return relogin !== null && (relogin.state === 'queued' || relogin.state === 'open');
}

/** Short state labels (pills). */
export const RELOGIN_STATE_LABEL: { readonly [K in TemplateReloginState]: string } = {
  queued: 'Waiting for you',
  open: 'Window open',
  filling: 'Filling from the vault',
  signed_in: 'Signed in again',
  failed: 'Re-login failed',
  timed_out: 'Re-login timed out',
  cancelled: 'Re-login cancelled',
};

/** Why a re-login failed (`ReloginView.error`), in words; unknown codes are shown plainly. */
export function reloginErrorText(error: string | null, state: TemplateReloginState): string {
  const known: Readonly<Record<string, string>> = {
    fill_failed:
      'The vault couldn’t fill the sign-in form. Check the form fields below, or sign in in a window.',
    not_authorized:
      'The vault binding doesn’t allow this template. Use Allow this template, or sign in in a window.',
    still_signed_out:
      'BrowserHive filled the form but the site still looks signed out. It may want a code or a check: sign in in a window.',
    timed_out: 'Nobody signed in within 30 minutes, so the window closed.',
    window_closed: 'The sign-in window was closed before the sign-in finished.',
    retry_window:
      'BrowserHive already tried an automatic re-login in the last 24 hours and does not retry it automatically. Sign in in a window.',
  };
  if (error !== null && error !== '') return known[error] ?? `${error.replaceAll('_', ' ')}.`;
  return state === 'timed_out' ? (known['timed_out'] ?? '') : 'The re-login didn’t finish.';
}

/** Why a binding refuses the template's fill (spec 13 §8.4, spec 02 §3.13). */
export const BINDING_PROBLEM_TEXT: { readonly [K in BindingProblem]: string } = {
  binding_not_found: 'No vault binding has this name any more. Pick another one.',
  principals_open:
    'The binding lets every principal use it. Automatic re-login needs this template named: list the principals that may use it on the Vault page, then come back and allow this template.',
  principal_not_listed:
    'The binding doesn’t list this template yet. Allow this template to let BrowserHive fill it.',
  // No longer reported (review #81 M-1: the template's own sign-in sessions satisfy the binding's
  // session names); kept for answers of an older server.
  slug_not_allowed:
    'The binding only allows some session names. Save again: this template’s own sign-in sessions are accepted whatever they are.',
  harness_list:
    'The binding (or its folder) only allows some harnesses. BrowserHive’s own fill has none, so it is refused: clear the harness list on the Vault page.',
};

/** Problems that **Allow this template** fixes (it only adds `template:<id>` to the principals). */
export const ALLOW_FIXES: ReadonlySet<BindingProblem> = new Set(['principal_not_listed']);

/**
 * The problems of a binding for a template, read from the binding itself (the server's
 * `binding_problems` replace them after a save). Folder policies are not seen here; the binding's
 * session names don't apply to the template's own sign-in sessions.
 */
export function bindingProblemsOf(
  binding: VaultBinding | undefined,
  templateId: string,
): readonly BindingProblem[] {
  if (binding === undefined) return ['binding_not_found'];
  const problems: BindingProblem[] = [];
  if (binding.authorized_principals.length === 0) problems.push('principals_open');
  else if (!binding.authorized_principals.includes(`template:${templateId}`))
    problems.push('principal_not_listed');
  if (binding.harnesses !== undefined) problems.push('harness_list');
  return problems;
}

/**
 * Who asked for a re-login, after "Asked for": `by admin` for an operator, `from Telegram (user
 * 1180442)` for the presser of a notification button (`telegram:1180442`).
 */
export function requesterText(requestedBy: string): string {
  const at = requestedBy.indexOf(':');
  const kind = at > 0 ? requestedBy.slice(0, at) : '';
  const label = NotificationChannelKind.safeParse(kind).success
    ? (PLATFORMS.find((p) => p.kind === kind)?.label ??
      kind.charAt(0).toUpperCase() + kind.slice(1))
    : undefined;
  if (label === undefined) return `by ${requestedBy}`;
  const user = requestedBy.slice(at + 1);
  return user === '' ? `from ${label}` : `from ${label} (user ${user})`;
}

/** Why a site was checked (Activity tab). */
export const PROBE_TRIGGER_LABEL: { readonly [K in TemplateProbeTrigger]: string } = {
  schedule: 'Scheduled',
  prelaunch: 'Before a launch',
  recording: 'Sign-in',
  relogin: 'Re-login',
  manual: 'Check now',
  host_start: 'Browser started',
  attention: 'After a takeover',
  restore: 'Restore or seed',
};
