/** @module cli/commands/templates-probe — `browserhive templates probe <name> [--site <site>]`: check now whether a template's sites are still signed in (**Check now**), one line per site with its outcome and reason (spec 13 §8.1, §11.5) */
import { type ProbeResult, ProbeTemplateResponse } from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';
import { findTemplate } from './templates.ts';
import { healthText } from './templates-ops.ts';

type ProbeInvocation = Extract<Invocation, { readonly command: 'templates-probe' }>;

/** The reasons of a generic site's check (spec 13 §8.1), in words; other reasons print as sent. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  learned_cookies: 'every sign-in cookie is there',
  cookies_absent: 'no sign-in cookie is left',
  partial_cookies: 'some sign-in cookies are missing',
  no_pack: 'no sign-in cookies learned yet',
};

function durationMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function resultLine(context: CommandContext, result: ProbeResult, width: number): string {
  const { style } = context.out;
  const why = REASON_TEXT[result.reason];
  const reason = why === undefined ? result.reason : `${why} (${result.reason})`;
  return `${result.site_id.padEnd(width)}  ${healthText(result.outcome, style)}  ${reason}  ${style.dim(durationMs(result.duration_ms))}`;
}

/** What to do about the sites that are not signed in. */
function printHints(context: CommandContext, name: string, results: readonly ProbeResult[]): void {
  const { out } = context;
  // A site without learned cookie names can only be told apart after a sign-in teaches them.
  const needLogin = results.filter((r) => r.outcome === 'signed_out' || r.reason === 'no_pack');
  const unsure = results.some((r) => r.outcome !== 'signed_in' && !needLogin.includes(r));
  if (needLogin.length === 0 && !unsure) return;
  out.line();
  for (const { site_id: site } of needLogin) {
    out.line(`Sign in to ${site} again: browserhive templates login ${name} --site ${site}`);
  }
  if (unsure) {
    out.line(
      "BrowserHive couldn't tell for some sites. Open a session and look, or sign in again to be sure.",
    );
  }
}

/**
 * `templates probe <name> [--site <site>]`: `POST …/probe` (waits up to 2 minutes; starts a stopped
 * browser) and one line per site.
 *
 * @returns 0 when every checked site is signed in, 2 when one is not, 1 on an API failure.
 */
export async function runTemplatesProbe(
  context: CommandContext,
  invocation: ProbeInvocation,
): Promise<ExitCode> {
  const { out } = context;
  const { remote, name, site, json } = invocation;
  const found = await findTemplate(context, remote, name);
  if (typeof found === 'number') return found;
  if (site !== null && !found.sites.some((s) => s.site_id === site)) {
    const sites = found.sites.map((s) => s.site_id).join(', ');
    out.diagnostic(`browserhive: template '${name}' has no site '${site}'. Its sites: ${sites}.`);
    return EXIT.fatal;
  }
  if (!json) out.line(`Checking ${site ?? `the sites of ${name}`}…`);
  const body = site === null ? {} : { site_ids: [site] };
  const result = await remoteCall(
    context,
    remote,
    'POST',
    `/templates/${found.template_id}/probe`,
    body,
  );
  if (!result.ok) return result.code;
  const parsed = ProbeTemplateResponse.safeParse(result.json);
  if (!parsed.success) {
    out.diagnostic('browserhive: the server answered with an unexpected probe result.');
    return EXIT.fatal;
  }
  const { results } = parsed.data;
  const signedIn = results.every((r) => r.outcome === 'signed_in');
  if (json) {
    out.json(parsed.data);
    return signedIn ? EXIT.ok : EXIT.warnings;
  }
  if (results.length === 0) {
    out.line('No enabled site to check.');
    return EXIT.ok;
  }
  const width = Math.max(...results.map((r) => r.site_id.length));
  for (const r of results) out.line(resultLine(context, r, width));
  printHints(context, name, results);
  return signedIn ? EXIT.ok : EXIT.warnings;
}
