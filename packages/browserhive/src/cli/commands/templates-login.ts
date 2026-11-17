/** @module cli/commands/templates-login — `browserhive templates login <name> --site <site>`: start a re-login (a window on the server's machine, or a vault fill), follow it every 2 s, send **I'm signed in** on Enter, cancel it on `--timeout` or Ctrl+C, and list the unlisted sign-ins (spec 13 §8.4, §11.5) */
import type { TemplateReloginState } from '@browserhive/contracts/enums';
import {
  ReloginResponse,
  type ReloginView,
  type TemplateSummary,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation, type RemoteTarget } from '../invocation.ts';
import { remoteCall, remoteRequest } from './admin-remote.ts';
import { formatTimestamp } from './common.ts';
import { findTemplate } from './templates.ts';
import { remoteHostName } from './templates-create.ts';
import { fetchTemplateDetail } from './templates-ops.ts';
import { durationText } from './templates-recording.ts';

type LoginInvocation = Extract<Invocation, { readonly command: 'templates-login' }>;

/** How often the command reads the re-login (the server checks the sign-in every 5 s). */
export const RELOGIN_POLL_MS = 2_000;

/** The states a re-login ends in (spec 13 §8.4). */
const FINISHED: ReadonlySet<TemplateReloginState> = new Set([
  'signed_in',
  'failed',
  'timed_out',
  'cancelled',
]);

/** The re-login the command follows. */
interface LoginTarget {
  readonly remote: RemoteTarget;
  readonly templateId: string;
  readonly name: string;
  readonly site: string;
  readonly machine: string;
  readonly json: boolean;
}

/** How the wait ended before the re-login did (an API failure is an exit code instead). */
type Stopped = 'timeout' | 'interrupt';

function unexpected(context: CommandContext): ExitCode {
  context.out.diagnostic('browserhive: the server answered with an unexpected re-login.');
  return EXIT.fatal;
}

function parseRelogin(context: CommandContext, json: unknown): ReloginResponse | ExitCode {
  const parsed = ReloginResponse.safeParse(json);
  return parsed.success ? parsed.data : unexpected(context);
}

/** The site must be one of the template's: said here rather than as the server's 404. */
function hasSite(context: CommandContext, template: TemplateSummary, site: string): boolean {
  if (template.sites.some((s) => s.site_id === site)) return true;
  const sites = template.sites.map((s) => s.site_id).join(', ');
  context.out.diagnostic(
    `browserhive: template '${template.name}' has no site '${site}'. Its sites: ${sites}.`,
  );
  return false;
}

function printStart(context: CommandContext, target: LoginTarget, view: ReloginView): void {
  const { out } = context;
  const lines: string[] = [];
  if (view.method === 'vault') {
    lines.push(
      `BrowserHive is filling the vault login linked to ${target.site} into its sign-in page, in a background window on ${target.machine}.`,
      'If the login asks for confirmation, approve it on the dashboard.',
    );
  } else if (view.state === 'queued') {
    lines.push(
      `The re-login is queued: press Show window on the template page to open it on ${target.machine}.`,
    );
  } else if (view.sign_in_via === 'live_view') {
    // A headless template (or a server without a display): no window to show (review #81 M-2).
    const live = `${target.remote.url.replace(/\/$/, '')}/sessions/${view.session_id ?? ''}?live=1&takeover=1`;
    lines.push(
      `${target.name}'s browser has no window to show on ${target.machine}: sign in to ${target.site} through the live view:`,
      `  ${live}`,
      'Agents wait only while you type there (up to 15 s per call).',
    );
  } else {
    lines.push(
      `A window opened on ${target.machine} at ${target.site}.`,
      'Sign in there by hand. Type your password rather than pasting it, and check the address bar first.',
    );
  }
  lines.push(
    view.agents_paused
      ? `Agents of ${target.name} are paused until you finish: their launches and tool calls wait. Press Let agents continue on the template page to release them.`
      : `Agents of ${target.name} keep running while you sign in.`,
  );
  if (view.method === 'window') {
    const closes =
      view.deadline_at === null
        ? ''
        : ` The window closes at ${formatTimestamp(view.deadline_at)}.`;
    lines.push(
      view.confirm_required
        ? `${target.site}'s sign-in cookies are already there, so BrowserHive can't tell when you are done: press Enter here (Done) once you have signed in again.${closes}`
        : `BrowserHive checks the sign-in every 5 s. Press Enter here when you are signed in.${closes}`,
    );
  }
  out.lines([...lines, '']);
}

/** Prints a line when the state or the pause changes (never for the endings: the summary does). */
function showChange(
  context: CommandContext,
  target: LoginTarget,
  before: ReloginView,
  after: ReloginView,
): void {
  const { out } = context;
  if (FINISHED.has(after.state)) return;
  if (after.state !== before.state) {
    if (after.state === 'open') out.line(`· window open on ${target.machine}`);
    if (after.state === 'filling') out.line('· filling the vault login');
    if (after.state === 'queued') out.line('· queued: press Show window on the template page');
  }
  if (before.agents_paused && !after.agents_paused) {
    out.line(`· agents of ${target.name} continue`);
  }
}

/** `GET /templates/{id}`: the template's re-login, which must still be this site's. */
async function readRelogin(
  context: CommandContext,
  target: LoginTarget,
): Promise<ReloginView | ExitCode> {
  const detail = await fetchTemplateDetail(context, target.remote, target.templateId);
  if (typeof detail === 'number') return detail;
  const view = detail.relogin;
  if (view !== null && view.site_id === target.site) return view;
  context.out.diagnostic(
    `browserhive: the re-login of ${target.site} is no longer known to the server (it may have restarted). Check the template page.`,
  );
  return EXIT.fatal;
}

/** **I'm signed in** (Enter). A 409 means no sign-in cookie came back yet: the wait goes on. */
async function confirm(
  context: CommandContext,
  target: LoginTarget,
): Promise<ReloginView | null | ExitCode> {
  const answer = await remoteRequest(
    context,
    target.remote,
    'POST',
    `/templates/${target.templateId}/relogin/confirm`,
    { site_id: target.site },
  );
  if (answer.ok) {
    const parsed = parseRelogin(context, answer.json);
    return typeof parsed === 'number' ? parsed : parsed.relogin;
  }
  if (answer.status !== 409) {
    answer.report();
    return answer.code;
  }
  const why = answer.problem?.detail ?? answer.problem?.title;
  context.out.diagnostic(
    `${target.site}: not signed in yet${why === undefined ? '' : ` (${why})`}. Finish signing in in the window, then press Enter again.`,
  );
  return null;
}

/**
 * Follows the re-login until it ends, `timeoutMs` passes or Ctrl+C. For a window, each Enter (a
 * line on stdin, terminal or pipe) sends **I'm signed in**.
 *
 * @returns The finished re-login, how the wait stopped, or an exit code after an API failure.
 */
async function follow(
  context: CommandContext,
  target: LoginTarget,
  first: ReloginView,
  timeoutMs: number,
): Promise<ReloginView | Stopped | ExitCode> {
  const { wait, clock } = context.deps;
  const deadline = clock.now() + timeoutMs;
  const never = new Promise<never>(() => undefined);
  const confirmOnEnter = first.method === 'window';
  let read = confirmOnEnter ? wait.readLine() : null;
  const enterOf = (pending: typeof read) =>
    pending === null
      ? never
      : pending.line.then((line) => (line === null ? never : ('enter' as const)));
  let enter = enterOf(read);
  let stopListening: () => void = () => undefined;
  const interrupt = new Promise<'interrupt'>((resolve) => {
    stopListening = wait.onInterrupt(() => resolve('interrupt'));
  });
  let view = first;
  try {
    for (;;) {
      if (FINISHED.has(view.state)) return view;
      const remaining = deadline - clock.now();
      if (remaining <= 0) return 'timeout';
      const tick = wait.sleep(Math.min(RELOGIN_POLL_MS, remaining)).then(() => 'tick' as const);
      const next = await Promise.race([enter, interrupt, tick]);
      if (next === 'interrupt') return next;
      let after: ReloginView | null | ExitCode;
      if (next === 'enter') {
        after = await confirm(context, target);
        read?.cancel();
        read = wait.readLine();
        enter = enterOf(read);
      } else {
        after = await readRelogin(context, target);
      }
      if (typeof after === 'number') return after;
      if (after === null) continue;
      if (!target.json) showChange(context, target, view, after);
      view = after;
    }
  } finally {
    read?.cancel();
    stopListening();
  }
}

/** `DELETE …/relogin` after `--timeout` or Ctrl+C: closes the window, so agents continue. */
async function cancel(
  context: CommandContext,
  target: LoginTarget,
): Promise<ReloginResponse | ExitCode> {
  const path = `/templates/${target.templateId}/relogin`;
  const result = await remoteCall(context, target.remote, 'DELETE', path);
  if (!result.ok) return result.code;
  return parseRelogin(context, result.json);
}

function printUnlisted(context: CommandContext, target: LoginTarget, domains: readonly string[]) {
  const { out } = context;
  if (domains.length === 0) return;
  out.line();
  out.line(`Also signed in to: ${domains.join(', ')} — agents can use this.`);
  out.line('Remove a sign-in with Remove sign-in on the template page, or over the REST API:');
  for (const domain of domains) {
    out.line(
      `  POST ${target.remote.url}/api/v1/templates/${target.templateId}/domains/${domain}/remove-sign-in`,
    );
  }
}

/** The ending of a re-login: a line, the unlisted sign-ins after a success, and the exit code. */
function report(context: CommandContext, target: LoginTarget, view: ReloginView): ExitCode {
  const { out } = context;
  if (target.json) {
    out.json({ session_id: view.session_id, relogin: view });
    return view.state === 'signed_in' ? EXIT.ok : EXIT.warnings;
  }
  const retry =
    view.method === 'vault'
      ? `Check the site's vault login on the template page (Allow this template), or sign in in a window: browserhive templates login ${target.name} --site ${target.site}`
      : `Try again with: browserhive templates login ${target.name} --site ${target.site}`;
  switch (view.state) {
    case 'signed_in':
      out.status(
        'ok',
        `${target.site} is signed in again`,
        view.version === null ? undefined : `saved as version ${view.version}`,
      );
      printUnlisted(context, target, view.unlisted_domains);
      return EXIT.ok;
    case 'failed':
      out.status('fail', `re-login of ${target.site} failed`, view.error ?? undefined);
      out.diagnostic(retry);
      return EXIT.warnings;
    case 'timed_out':
      out.status('fail', `${target.site} was not signed in before the window closed`);
      out.diagnostic(retry);
      return EXIT.warnings;
    default:
      out.status('warn', `the re-login of ${target.site} was cancelled`);
      return EXIT.warnings;
  }
}

/**
 * `templates login <name> --site <site> [--method window|vault] [--timeout] [--letAgentsContinue]`.
 *
 * @returns 0 when the site is signed in again, 2 when the re-login failed, timed out or was
 * cancelled (also at `--timeout`), 1 on an API failure or Ctrl+C.
 */
export async function runTemplatesLogin(
  context: CommandContext,
  invocation: LoginInvocation,
): Promise<ExitCode> {
  const { out } = context;
  const { remote, name, site, json, method } = invocation;
  const found = await findTemplate(context, remote, name);
  if (typeof found === 'number') return found;
  if (!hasSite(context, found, site)) return EXIT.fatal;
  const detail = await fetchTemplateDetail(context, remote, found.template_id);
  if (typeof detail === 'number') return detail;
  const target: LoginTarget = {
    remote,
    templateId: found.template_id,
    name,
    site,
    machine: detail.machine.name,
    json,
  };
  if (method === 'window' && remoteHostName(remote) !== null) {
    out.diagnostic(`! This opens a window on ${target.machine}, not on this device.`);
  }
  const body = { site_id: site, method, let_agents_continue: invocation.letAgentsContinue };
  const result = await remoteCall(
    context,
    remote,
    'POST',
    `/templates/${target.templateId}/relogin`,
    body,
  );
  if (!result.ok) return result.code;
  const started = parseRelogin(context, result.json);
  if (typeof started === 'number') return started;
  if (!json) printStart(context, target, started.relogin);
  const outcome = await follow(context, target, started.relogin, invocation.timeoutMs);
  if (typeof outcome === 'number') return outcome;
  if (typeof outcome === 'object') return report(context, target, outcome);
  const cancelled = await cancel(context, target);
  if (typeof cancelled === 'number') return cancelled;
  if (json) out.json(cancelled);
  if (outcome === 'timeout') {
    out.diagnostic(
      `Timed out after ${durationText(invocation.timeoutMs)}: the re-login of ${site} was cancelled and its window closed.`,
    );
    return EXIT.warnings;
  }
  out.diagnostic(`Stopped: the re-login of ${site} was cancelled and its window closed.`);
  return EXIT.fatal;
}
