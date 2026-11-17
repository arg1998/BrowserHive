/** @module cli/commands/templates-clipboard — `browserhive templates clipboard <name> deny|allow [--restart]`: the template's "Deny clipboard writes" switch over `PATCH /templates/{id}` (spec 13 §2.1, §11.5; D18). It reaches a running browser's pages at once; pages already open are fully covered only after a browser restart, which `--restart` does. */
import { TemplateChangeResponse, TemplateHostResponse } from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';
import { findTemplate } from './templates.ts';

type ClipboardInvocation = Extract<Invocation, { readonly command: 'templates-clipboard' }>;

/**
 * `templates clipboard <name> deny|allow [--restart]`.
 *
 * @returns 0, or 1 on an API failure (the switch, or the restart `--restart` asked for).
 */
export async function runTemplatesClipboard(
  context: CommandContext,
  invocation: ClipboardInvocation,
): Promise<ExitCode> {
  const { out } = context;
  const found = await findTemplate(context, invocation.remote, invocation.name);
  if (typeof found === 'number') return found;
  const result = await remoteCall(
    context,
    invocation.remote,
    'PATCH',
    `/templates/${found.template_id}`,
    { deny_clipboard_writes: invocation.deny },
  );
  if (!result.ok) return result.code;
  const parsed = TemplateChangeResponse.safeParse(result.json);
  if (!parsed.success) {
    out.diagnostic('browserhive: the server answered with an unexpected template.');
    return EXIT.fatal;
  }
  const { template } = parsed.data;
  const needsRestart = parsed.data.clipboard_needs_restart === true;
  let restarted: TemplateHostResponse | null = null;
  if (needsRestart && invocation.restart) {
    const path = `/templates/${found.template_id}/host/restart`;
    const restart = await remoteCall(context, invocation.remote, 'POST', path, {});
    if (!restart.ok) return restart.code;
    const host = TemplateHostResponse.safeParse(restart.json);
    if (!host.success) {
      out.diagnostic('browserhive: the server answered with an unexpected browser state.');
      return EXIT.fatal;
    }
    restarted = host.data;
  }
  if (invocation.json) {
    out.json({
      template,
      clipboard_needs_restart: needsRestart && restarted === null,
      ...(restarted !== null && { host: restarted.host }),
    });
    return EXIT.ok;
  }
  out.status(
    'ok',
    template.deny_clipboard_writes
      ? `pages in ${invocation.name}'s browser can no longer write the clipboard`
      : `pages in ${invocation.name}'s browser may write the clipboard again`,
    needsRestart ? 'pages it opens from now on' : 'applies at once',
  );
  if (restarted !== null) {
    out.status('ok', `restarted the browser of ${invocation.name}`, 'every page covered');
  } else if (needsRestart) {
    out.status(
      'warn',
      template.deny_clipboard_writes
        ? 'pages already open may still write it until the browser restarts'
        : 'pages already open keep refusing to copy until they reload',
      `--restart, or templates host ${invocation.name} restart (its sessions close)`,
    );
  }
  return EXIT.ok;
}
