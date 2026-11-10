/** @module cli/commands/templates — `browserhive templates list | rm <name>`: session templates over a running server's REST API (spec 13 §11.5). `create`, `finish` and the other subcommands arrive with the later template PRs. */
import {
  DeleteTemplateResponse,
  type TemplateSummary,
  TemplatesPage,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation, type RemoteTarget } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';
import { formatTimestamp } from './common.ts';

/** Every template, by name (one page of the API's maximum covers any realistic install). */
async function listTemplates(
  context: CommandContext,
  remote: RemoteTarget,
): Promise<readonly TemplateSummary[] | ExitCode> {
  const result = await remoteCall(context, remote, 'GET', '/templates?sort=name&dir=asc&limit=500');
  if (!result.ok) return result.code;
  const parsed = TemplatesPage.safeParse(result.json);
  if (!parsed.success) {
    context.out.diagnostic('browserhive: the server answered with an unexpected template list.');
    return EXIT.fatal;
  }
  return parsed.data.data;
}

const STATUS_TEXT: Readonly<Record<TemplateSummary['status'], string>> = {
  recording: 'setting up',
  ready: 'ready',
  disabled: 'disabled',
};

/** `linkedin.com ✓, indeed.com ✗`: one mark per site's sign-in state. */
function sitesText(template: TemplateSummary): string {
  const mark: Readonly<Record<string, string>> = {
    signed_in: '✓',
    signed_out: '✗',
    challenged: '!',
    inconclusive: '?',
    unknown: '·',
  };
  return template.sites.map((s) => `${s.site_id} ${mark[s.health_state] ?? '·'}`).join(', ');
}

/**
 * `templates list`.
 *
 * @returns The exit code.
 */
export async function runTemplatesList(
  context: CommandContext,
  remote: RemoteTarget,
  json: boolean,
): Promise<ExitCode> {
  const { out } = context;
  const templates = await listTemplates(context, remote);
  if (typeof templates === 'number') return templates;
  if (json) {
    out.json(templates);
    return EXIT.ok;
  }
  if (templates.length === 0) {
    out.line(
      'No session templates. Create one with POST /api/v1/templates (the CLI and dashboard arrive in a later release).',
    );
    return EXIT.ok;
  }
  out.table(
    [
      { header: 'NAME' },
      { header: 'STATUS' },
      { header: 'SITES' },
      { header: 'BROWSER' },
      { header: 'SESSIONS' },
      { header: 'LAST USED' },
    ],
    templates.map((t) => [
      out.style.bold(t.name),
      STATUS_TEXT[t.status],
      sitesText(t),
      t.host.state,
      `${t.in_use}/${t.cap}`,
      t.last_used_at === null ? 'never' : formatTimestamp(t.last_used_at),
    ]),
  );
  return EXIT.ok;
}

/**
 * `templates rm <name> [--force] [--yes]`: asks for the name again on a terminal and refuses
 * without one unless `--yes` (spec 13 §11.5).
 *
 * @returns The exit code.
 */
export async function runTemplatesRm(
  context: CommandContext,
  invocation: Extract<Invocation, { readonly command: 'templates-rm' }>,
): Promise<ExitCode> {
  const { out, deps } = context;
  const { remote, name } = invocation;
  const templates = await listTemplates(context, remote);
  if (typeof templates === 'number') return templates;
  const template = templates.find((t) => t.name === name);
  if (template === undefined) {
    out.diagnostic(`browserhive: no session template named '${name}'.`);
    return EXIT.fatal;
  }
  if (!invocation.yes) {
    if (deps.prompt === null) {
      out.diagnostic(
        'browserhive templates rm: refusing to delete without confirmation, and stdin is not a terminal.',
      );
      out.diagnostic('Run it in a terminal, or pass --yes if you are scripting this deliberately.');
      return EXIT.fatal;
    }
    out.line(
      `This deletes template '${name}' (${template.template_id}) and its browser profile. It does not sign out at the sites.`,
    );
    const answer = await deps.prompt(`Type the template's name to confirm: `);
    if (answer.trim() !== name) {
      out.line('Aborted — nothing was deleted.');
      return EXIT.fatal;
    }
  }
  const query = invocation.force ? '?force=true' : '';
  const result = await remoteCall(
    context,
    remote,
    'DELETE',
    `/templates/${template.template_id}${query}`,
  );
  if (!result.ok) return result.code;
  const parsed = DeleteTemplateResponse.safeParse(result.json);
  if (!parsed.success) {
    out.diagnostic('browserhive: the server answered with an unexpected result.');
    return EXIT.fatal;
  }
  if (invocation.json) {
    out.json(parsed.data);
    return EXIT.ok;
  }
  const closed = parsed.data.closed_sessions.length;
  out.status(
    'ok',
    `deleted template ${name}`,
    closed === 0 ? undefined : `${closed} session(s) closed`,
  );
  return EXIT.ok;
}
