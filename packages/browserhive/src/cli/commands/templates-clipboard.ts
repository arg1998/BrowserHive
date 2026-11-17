/** @module cli/commands/templates-clipboard — `browserhive templates clipboard <name> deny|allow`: the template's "Deny clipboard writes" switch over `PATCH /templates/{id}` (spec 13 §2.1, §11.5; D18). It applies to a running browser at once. */
import { TemplateChangeResponse } from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';
import { findTemplate } from './templates.ts';

type ClipboardInvocation = Extract<Invocation, { readonly command: 'templates-clipboard' }>;

/**
 * `templates clipboard <name> deny|allow`.
 *
 * @returns 0, or 1 on an API failure.
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
  if (invocation.json) {
    out.json(parsed.data.template);
    return EXIT.ok;
  }
  out.status(
    'ok',
    parsed.data.template.deny_clipboard_writes
      ? `pages in ${invocation.name}'s browser can no longer write the clipboard`
      : `pages in ${invocation.name}'s browser may write the clipboard again`,
    'applies at once',
  );
  return EXIT.ok;
}
