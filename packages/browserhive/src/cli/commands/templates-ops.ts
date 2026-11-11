/** @module cli/commands/templates-ops — `browserhive templates show | versions | save | host | disable | enable <name>` over a running server's REST API (spec 13 §3.9, §11.1, §11.5); `seed` and `restore` are in `templates-state.ts`. */
import type { TemplateHealthState } from '@browserhive/contracts/enums';
import {
  type HostView,
  SaveTemplateVersionResponse,
  type Template,
  TemplateChangeResponse,
  TemplateDetailResponse,
  TemplateHostResponse,
  type TemplateVersionRow,
  TemplateVersionsPage,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation, type RemoteTarget } from '../invocation.ts';
import type { Style } from '../output/style.ts';
import { remoteCall } from './admin-remote.ts';
import { formatTimestamp, size } from './common.ts';
import { findTemplate } from './templates.ts';

type Of<C extends Invocation['command']> = Extract<Invocation, { readonly command: C }>;

/** One page of the API's maximum covers every version retention keeps (`templateVersionsKeep` ≤ 100, plus pinned). */
const VERSIONS_LIMIT = 500;

function unexpected(context: CommandContext, what: string): ExitCode {
  context.out.diagnostic(`browserhive: the server answered with an unexpected ${what}.`);
  return EXIT.fatal;
}

/**
 * `GET /templates/{id}`: the template, its browser and its sites.
 *
 * @returns The detail, or an exit code after printing the failure.
 */
export async function fetchTemplateDetail(
  context: CommandContext,
  remote: RemoteTarget,
  templateId: string,
): Promise<TemplateDetailResponse | ExitCode> {
  const result = await remoteCall(context, remote, 'GET', `/templates/${templateId}`);
  if (!result.ok) return result.code;
  const parsed = TemplateDetailResponse.safeParse(result.json);
  return parsed.success ? parsed.data : unexpected(context, 'template');
}

const HEALTH_TEXT: Readonly<Record<TemplateHealthState, string>> = {
  unknown: '· not checked',
  signed_in: '✓ signed in',
  signed_out: '✗ signed out',
  inconclusive: "? couldn't tell",
  challenged: '! check needed',
};

/**
 * One site's sign-in state as a coloured mark and word.
 *
 * @returns The text.
 */
export function healthText(state: TemplateHealthState, style: Style): string {
  const text = HEALTH_TEXT[state];
  if (state === 'signed_in') return style.green(text);
  if (state === 'signed_out') return style.red(text);
  if (state === 'unknown') return style.dim(text);
  return style.yellow(text);
}

function accessText(template: Template): string {
  const principals = template.policy.authorized_principals;
  return principals.length === 0 ? 'every agent principal' : principals.join(', ');
}

function templateLines(template: Template, live: number): readonly [string, string][] {
  const checkpoint =
    template.checkpoint_at === null
      ? 'no checkpoint yet'
      : `checkpoint ${formatTimestamp(template.checkpoint_at)}${template.checkpoint_size_bytes === null ? '' : ` (${size(template.checkpoint_size_bytes)})`}`;
  const version =
    template.current_version === null ? 'no version yet' : `v${template.current_version}`;
  return [
    ['display name', template.display_name],
    ...(template.description === ''
      ? []
      : ([['description', template.description]] as [string, string][])),
    [
      'browser',
      `${template.channel} · ${template.headless ? 'headless' : 'headed'} · stealth ${template.stealth}`,
    ],
    ['identity', `${template.identity.locale} · ${template.identity.timezone_id}`],
    ['proxy', template.proxy === null ? 'none' : template.proxy.label],
    ['access', accessText(template)],
    ['sessions', `${live} live · cap ${template.policy.max_concurrent}`],
    ['state', `${version} · ${checkpoint}`],
    [
      'created',
      `${formatTimestamp(template.created_at)} · last used ${template.last_used_at === null ? 'never' : formatTimestamp(template.last_used_at)}`,
    ],
  ];
}

function hostLines(host: HostView): readonly [string, string][] {
  const since = host.since === null ? '' : ` since ${formatTimestamp(host.since)}`;
  const sandbox = host.sandboxed === null ? 'not started yet' : host.sandboxed ? 'on' : 'off';
  return [
    ['state', `${host.state}${since}`],
    ['pages', `${host.pages} agent · ${host.parked_pages} parked`],
    ...(host.rss_bytes === undefined
      ? []
      : ([['memory', size(host.rss_bytes)]] as [string, string][])),
    ['restarts', String(host.restarts)],
    ['sandbox', sandbox],
    ...(host.last_error === undefined
      ? []
      : ([['last error', host.last_error]] as [string, string][])),
  ];
}

function printPairs(context: CommandContext, pairs: readonly [string, string][]): void {
  const width = Math.max(...pairs.map(([label]) => label.length));
  for (const [label, value] of pairs) {
    context.out.line(`  ${context.out.style.dim(label.padEnd(width))}  ${value}`);
  }
}

/**
 * `templates show <name>`: the template, its browser (`HostView`) and its sites.
 *
 * @returns 0, or 1 on an API failure.
 */
export async function runTemplatesShow(
  context: CommandContext,
  invocation: Of<'templates-show'>,
): Promise<ExitCode> {
  const { out } = context;
  const found = await findTemplate(context, invocation.remote, invocation.name);
  if (typeof found === 'number') return found;
  const detail = await fetchTemplateDetail(context, invocation.remote, found.template_id);
  if (typeof detail === 'number') return detail;
  if (invocation.json) {
    out.json(detail);
    return EXIT.ok;
  }
  const { template, host } = detail;
  const status = template.status === 'recording' ? 'setting up' : template.status;
  out.line(`${out.style.bold(template.name)} (${template.template_id}) · ${status}`);
  printPairs(context, templateLines(template, detail.sessions_live));
  out.line();
  out.line(out.style.bold('Browser'));
  printPairs(context, hostLines(host));
  if (host.profile_secrets) {
    out.status(
      'warn',
      'saved passwords or autofill data in the profile',
      'agents can read what the browser fills; clear them from the template page',
    );
  }
  out.line();
  out.table(
    [{ header: 'SITE' }, { header: 'SIGN-IN' }, { header: 'CHECKED' }, { header: 'ENABLED' }],
    detail.sites.map((site) => [
      site.site_id,
      healthText(site.health.state, out.style),
      formatTimestamp(site.health.checked_at),
      site.enabled ? 'yes' : 'no',
    ]),
  );
  if (detail.unlisted_domains.length > 0) {
    out.line();
    out.line(`Also signed in to: ${detail.unlisted_domains.join(', ')}`);
  }
  return EXIT.ok;
}

/** `2/3`: the enabled sites signed in when the version was written, of the enabled sites. */
function signedInText(row: TemplateVersionRow): string {
  const enabled = row.health.filter((site) => site.enabled);
  const signedIn = enabled.filter((site) => site.state === 'signed_in');
  return `${signedIn.length}/${enabled.length}`;
}

function versionRow(row: TemplateVersionRow, style: Style): readonly string[] {
  const reason =
    row.reason === 'restore' && row.restored_from !== null
      ? `restore (from ${row.restored_from === 0 ? 'latest' : `v${row.restored_from}`})`
      : row.reason;
  return [
    `v${row.version}`,
    reason,
    formatTimestamp(row.created_at),
    size(row.size_bytes),
    signedInText(row),
    row.pinned ? 'yes' : '',
    row.last_good ? 'yes' : '',
    row.readable ? 'yes' : style.red('no'),
  ];
}

/**
 * `templates versions <name>`: the versions (newest first) and the rolling checkpoint.
 *
 * @returns 0, or 1 on an API failure.
 */
export async function runTemplatesVersions(
  context: CommandContext,
  invocation: Of<'templates-versions'>,
): Promise<ExitCode> {
  const { out } = context;
  const found = await findTemplate(context, invocation.remote, invocation.name);
  if (typeof found === 'number') return found;
  const path = `/templates/${found.template_id}/versions?limit=${VERSIONS_LIMIT}`;
  const result = await remoteCall(context, invocation.remote, 'GET', path);
  if (!result.ok) return result.code;
  const parsed = TemplateVersionsPage.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'version list');
  const { data: rows, checkpoint } = parsed.data;
  if (invocation.json) {
    out.json({ versions: rows, checkpoint });
    return EXIT.ok;
  }
  if (rows.length === 0) {
    out.line(`No versions of ${invocation.name} yet.`);
  } else {
    out.table(
      [
        { header: 'VERSION' },
        { header: 'REASON' },
        { header: 'CREATED' },
        { header: 'SIZE' },
        { header: 'SIGNED IN' },
        { header: 'PINNED' },
        { header: 'LAST GOOD' },
        { header: 'READABLE' },
      ],
      rows.map((row) => versionRow(row, out.style)),
    );
  }
  out.line();
  if (checkpoint === null) {
    out.line('Checkpoint: none yet (written while the browser runs).');
  } else {
    const unreadable = checkpoint.readable ? '' : ` · ${out.style.red('unreadable')}`;
    out.line(
      `Checkpoint: ${formatTimestamp(checkpoint.at)} · ${size(checkpoint.size_bytes)}${unreadable}`,
    );
  }
  if (rows.some((row) => !row.readable) || checkpoint?.readable === false) {
    out.line(
      'Unreadable: the file is missing or was written with another key (templateKey, templateKeyPrevious, templates rekey).',
    );
  }
  return EXIT.ok;
}

/**
 * `templates save <name>`: writes a `manual` version of the running browser's sign-ins.
 *
 * @returns 0 (also when nothing changed), or 1 on an API failure (409 when the browser is not running).
 */
export async function runTemplatesSave(
  context: CommandContext,
  invocation: Of<'templates-save'>,
): Promise<ExitCode> {
  const { out } = context;
  const found = await findTemplate(context, invocation.remote, invocation.name);
  if (typeof found === 'number') return found;
  const path = `/templates/${found.template_id}/versions`;
  const result = await remoteCall(context, invocation.remote, 'POST', path, {});
  if (!result.ok) return result.code;
  const parsed = SaveTemplateVersionResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'result');
  if (invocation.json) {
    out.json(parsed.data);
    return EXIT.ok;
  }
  const { version } = parsed.data;
  if (version === null) {
    out.status('ok', `nothing changed in ${invocation.name}`, 'no new version written');
  } else {
    out.status('ok', `saved ${invocation.name} as version ${version}`);
  }
  return EXIT.ok;
}

const HOST_DONE: Readonly<Record<Of<'templates-host'>['action'], string>> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
};

/**
 * `templates host <name> start|stop|restart`.
 *
 * @returns 0, or 1 on an API failure.
 */
export async function runTemplatesHost(
  context: CommandContext,
  invocation: Of<'templates-host'>,
): Promise<ExitCode> {
  const { out } = context;
  const found = await findTemplate(context, invocation.remote, invocation.name);
  if (typeof found === 'number') return found;
  const path = `/templates/${found.template_id}/host/${invocation.action}`;
  const result = await remoteCall(context, invocation.remote, 'POST', path, {});
  if (!result.ok) return result.code;
  const parsed = TemplateHostResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'browser state');
  if (invocation.json) {
    out.json(parsed.data);
    return EXIT.ok;
  }
  out.status(
    'ok',
    `${HOST_DONE[invocation.action]} the browser of ${invocation.name}`,
    `now ${parsed.data.host.state}`,
  );
  return EXIT.ok;
}

/**
 * `templates disable <name>` (closes its sessions, refuses new ones) and `templates enable <name>`.
 *
 * @returns 0, or 1 on an API failure.
 */
export async function runTemplatesAvailability(
  context: CommandContext,
  invocation: Of<'templates-disable'> | Of<'templates-enable'>,
): Promise<ExitCode> {
  const { out } = context;
  const enable = invocation.command === 'templates-enable';
  const found = await findTemplate(context, invocation.remote, invocation.name);
  if (typeof found === 'number') return found;
  const path = `/templates/${found.template_id}/${enable ? 'enable' : 'disable'}`;
  const result = await remoteCall(context, invocation.remote, 'POST', path, {});
  if (!result.ok) return result.code;
  const parsed = TemplateChangeResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'template');
  if (invocation.json) {
    out.json(parsed.data);
    return EXIT.ok;
  }
  const closed = parsed.data.closed_sessions.length;
  out.status(
    'ok',
    `${enable ? 'enabled' : 'disabled'} template ${invocation.name}`,
    closed === 0 ? undefined : `${closed} session(s) closed`,
  );
  return EXIT.ok;
}
