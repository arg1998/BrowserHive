/** @module cli/commands/templates-recording — the sign-in wait of `templates create` (poll every 2 s, Enter, `--timeout`, Ctrl+C) and the finishing tail it shares with `templates finish`: confirm the sites, offer to remove unlisted sign-ins, finish (spec 13 §7.1, §7.2, §11.5) */
import type { TemplateHealthState } from '@browserhive/contracts/enums';
import {
  FinishRecordingResponse,
  TemplateDetailResponse,
  type TemplateSiteView,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type RemoteTarget } from '../invocation.ts';
import type { Style } from '../output/style.ts';
import { remoteCall, remoteRequest } from './admin-remote.ts';

/** How often the sign-in wait reads the template's sites (spec 13 §7.2). */
export const RECORDING_POLL_MS = 2_000;

/** The template a recording belongs to. */
export interface RecordingTarget {
  readonly remote: RemoteTarget;
  readonly templateId: string;
  readonly name: string;
  readonly json: boolean;
}

/** How the sign-in wait ended (an API failure is an exit code instead). */
export type WaitOutcome = 'signed_in' | 'enter' | 'timeout' | 'interrupt';

const STATE_TEXT: Readonly<Record<TemplateHealthState, string>> = {
  unknown: '· waiting',
  signed_in: '✓ signed in',
  signed_out: '✗ signed out',
  inconclusive: "? couldn't tell",
  challenged: '! check needed',
};

function stateText(state: TemplateHealthState, style: Style): string {
  const text = STATE_TEXT[state];
  if (state === 'signed_in') return style.green(text);
  if (state === 'signed_out') return style.red(text);
  if (state === 'unknown') return style.dim(text);
  return style.yellow(text);
}

function siteLine(site: TemplateSiteView, width: number, text: string): string {
  return `${site.site_id.padEnd(width)}  ${text}`;
}

function enabledSites(detail: { readonly sites: readonly TemplateSiteView[] }): TemplateSiteView[] {
  return detail.sites.filter((site) => site.enabled);
}

/**
 * `30m`, `2h`, `45s`: a duration as the flags spell it.
 *
 * @returns The text.
 */
export function durationText(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.ceil(ms / 1000)}s`;
}

async function templateDetail(
  context: CommandContext,
  target: RecordingTarget,
): Promise<TemplateDetailResponse | ExitCode> {
  const result = await remoteCall(context, target.remote, 'GET', `/templates/${target.templateId}`);
  if (!result.ok) return result.code;
  const parsed = TemplateDetailResponse.safeParse(result.json);
  if (parsed.success) return parsed.data;
  context.out.diagnostic('browserhive: the server answered with an unexpected template.');
  return EXIT.fatal;
}

/** Prints a line for every site whose state differs from the last one shown. */
function showChanges(
  context: CommandContext,
  sites: readonly TemplateSiteView[],
  shown: Map<string, TemplateHealthState>,
): void {
  const width = Math.max(...sites.map((site) => site.site_id.length));
  for (const site of sites) {
    if (shown.get(site.site_id) === site.health.state) continue;
    shown.set(site.site_id, site.health.state);
    context.out.line(siteLine(site, width, stateText(site.health.state, context.out.style)));
  }
}

/**
 * Waits until every site is signed in, the operator presses Enter (a line on stdin, terminal or
 * pipe; the end of input keeps waiting), `timeoutMs` passes, or Ctrl+C. Reads the template every
 * {@link RECORDING_POLL_MS} and prints a line when a site's state changes (none with `--json`).
 *
 * @returns How the wait ended, or an exit code after an API failure.
 */
export async function waitForSignIns(
  context: CommandContext,
  target: RecordingTarget,
  timeoutMs: number,
): Promise<WaitOutcome | ExitCode> {
  const { wait, clock } = context.deps;
  const deadline = clock.now() + timeoutMs;
  const read = wait.readLine();
  const enter = read.line.then((line) =>
    line === null ? new Promise<never>(() => undefined) : ('enter' as const),
  );
  let stopListening: () => void = () => undefined;
  const interrupt = new Promise<'interrupt'>((resolve) => {
    stopListening = wait.onInterrupt(() => resolve('interrupt'));
  });
  const shown = new Map<string, TemplateHealthState>();
  try {
    for (;;) {
      const detail = await templateDetail(context, target);
      if (typeof detail === 'number') return detail;
      const sites = enabledSites(detail);
      if (!target.json) showChanges(context, sites, shown);
      if (sites.every((site) => site.health.state === 'signed_in')) return 'signed_in';
      const remaining = deadline - clock.now();
      if (remaining <= 0) return 'timeout';
      const tick = wait.sleep(Math.min(RECORDING_POLL_MS, remaining)).then(() => 'tick' as const);
      const next = await Promise.race([enter, interrupt, tick]);
      if (next !== 'tick') return next;
    }
  } finally {
    read.cancel();
    stopListening();
  }
}

/** Confirms every site not yet signed in; a 409 means the operator did not sign in there. */
async function confirmSites(
  context: CommandContext,
  target: RecordingTarget,
  sites: readonly TemplateSiteView[],
): Promise<ExitCode | null> {
  for (const site of sites.filter((s) => s.health.state !== 'signed_in')) {
    const answer = await remoteRequest(
      context,
      target.remote,
      'POST',
      `/templates/${target.templateId}/recording/confirm`,
      { site_id: site.site_id },
    );
    if (answer.ok) continue;
    if (answer.status !== 409) {
      answer.report();
      return answer.code;
    }
    const why = answer.problem?.detail ?? answer.problem?.title;
    context.out.diagnostic(`${site.site_id}: not signed in${why === undefined ? '' : ` (${why})`}`);
  }
  return null;
}

/** The unlisted sign-ins to remove: all of them unless the operator answers no on a terminal. */
async function chooseRemovals(
  context: CommandContext,
  domains: readonly string[],
  json: boolean,
): Promise<readonly string[]> {
  const { out, deps } = context;
  if (domains.length === 0) return [];
  const all = domains.slice(0, 64);
  if (json) return all;
  out.line();
  out.line(`Also signed in to: ${domains.join(', ')} — agents can use this.`);
  if (deps.prompt === null) {
    out.line('Removing these sign-ins (run in a terminal to keep them).');
    return all;
  }
  const answer = (await deps.prompt('Remove these sign-ins? [Y/n] ')).trim().toLowerCase();
  if (answer === 'n' || answer === 'no') {
    out.line('Kept them: agents of this template can use these sign-ins.');
    return [];
  }
  return all;
}

function printSummary(
  context: CommandContext,
  name: string,
  sites: readonly TemplateSiteView[],
): void {
  const { out } = context;
  const width = Math.max(...sites.map((site) => site.site_id.length));
  out.line();
  for (const site of sites) {
    const text =
      site.health.state === 'signed_out'
        ? out.style.red('✗ not signed in')
        : stateText(site.health.state, out.style);
    out.line(siteLine(site, width, text));
  }
  out.status('ok', `template ${name} is ready`);
  const missing = sites.filter((site) => site.health.state !== 'signed_in');
  if (missing.length > 0) {
    const list = missing.map((site) => site.site_id).join(', ');
    out.status(
      'warn',
      `${list} ${missing.length === 1 ? 'is' : 'are'} not signed in`,
      'kept and marked signed out',
    );
  }
}

/**
 * Finishes a recording: **I'm signed in** for every site not yet signed in, lists the unlisted
 * sign-ins and removes them (asked on a terminal, preselected), then sets the template ready.
 *
 * @returns 0 when every site is signed in, 2 when one is not, 1 on an API failure.
 */
export async function finishRecording(
  context: CommandContext,
  target: RecordingTarget,
): Promise<ExitCode> {
  const before = await templateDetail(context, target);
  if (typeof before === 'number') return before;
  const refused = await confirmSites(context, target, enabledSites(before));
  if (refused !== null) return refused;
  const after = await templateDetail(context, target);
  if (typeof after === 'number') return after;
  const removals = await chooseRemovals(context, after.unlisted_domains, target.json);
  const result = await remoteCall(
    context,
    target.remote,
    'POST',
    `/templates/${target.templateId}/recording/finish`,
    removals.length > 0 ? { remove_sign_ins: removals } : {},
  );
  if (!result.ok) return result.code;
  const parsed = FinishRecordingResponse.safeParse(result.json);
  if (!parsed.success) {
    context.out.diagnostic('browserhive: the server answered with an unexpected result.');
    return EXIT.fatal;
  }
  const { template, version, removed_sign_ins: removed } = parsed.data;
  const sites = enabledSites(template);
  if (target.json) {
    context.out.json({ template, version, sites, removed_sign_ins: removals });
  } else {
    printSummary(context, target.name, sites);
    // A removal that left site data behind is never silent (the sign-in may survive there).
    for (const entry of removed) {
      if (entry.uncleared_origins.length === 0) continue;
      context.out.status(
        'warn',
        `${entry.domain}: site data not cleared for ${entry.uncleared_origins.join(', ')}`,
        'the sign-in may survive there; remove it again from the template page',
      );
    }
  }
  return sites.every((site) => site.health.state === 'signed_in') ? EXIT.ok : EXIT.warnings;
}
