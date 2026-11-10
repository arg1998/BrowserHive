/** @module cli/commands/templates-state — `browserhive templates seed <name> <file>` and `templates restore <name> <version|latest>`: a typed-name confirmation on a terminal, the request, then a 1 s poll of the operation until it finishes (spec 13 §3.12, §7.4, §11.5). `templates create --fromState` reuses the seeding tail. */
import {
  TEMPLATE_SEED_MAX_BYTES,
  type TemplateDetailResponse,
  TemplateOperation,
  TemplateOperationAccepted,
  TemplateStorageState,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation, type RemoteTarget } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';
import { size } from './common.ts';
import { findTemplate } from './templates.ts';
import { fetchTemplateDetail, healthText } from './templates-ops.ts';

type Of<C extends Invocation['command']> = Extract<Invocation, { readonly command: C }>;

/** How often the CLI reads a running restore or seed operation. */
export const OPERATION_POLL_MS = 1_000;

/** A storage-state file read in memory: the parsed JSON (sent as is) and its counts. */
export interface StateFile {
  readonly body: unknown;
  readonly cookies: number;
  readonly origins: number;
}

/**
 * Reads and checks a storage-state file locally (≤ 16 MiB, JSON, Playwright's shape) before
 * anything is sent. The file is only read; nothing is written anywhere.
 *
 * @returns The state, or 1 after printing why it cannot be used.
 */
export async function readStateFile(
  context: CommandContext,
  path: string,
): Promise<StateFile | ExitCode> {
  const { deps, out } = context;
  const refuse = (why: string): ExitCode => {
    out.diagnostic(`browserhive: ${path} ${why}`);
    return EXIT.fatal;
  };
  const info = await deps.fs.stat(path);
  if (info === null || !info.isFile) return refuse('does not exist or is not a file.');
  if (info.sizeBytes > TEMPLATE_SEED_MAX_BYTES) {
    return refuse(
      `is ${size(info.sizeBytes)}; a storage state may be at most ${size(TEMPLATE_SEED_MAX_BYTES)}.`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(await deps.fs.readFile(path));
  } catch {
    return refuse(
      'is not JSON. Expected a Playwright storage state ({"cookies": […], "origins": […]}).',
    );
  }
  const parsed = TemplateStorageState.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`;
    return refuse(
      `is not a Playwright storage state${where}: ${issue?.message ?? 'unexpected shape'}.`,
    );
  }
  return { body, cookies: parsed.data.cookies.length, origins: parsed.data.origins.length };
}

/**
 * The confirmation of `seed` and `restore`: on a terminal the operator types the template's name;
 * without one the command refuses unless `--yes` (spec 13 §11.5).
 *
 * @returns `true` to go ahead, else the exit code after printing why not.
 */
async function confirmByName(
  context: CommandContext,
  input: { readonly name: string; readonly command: string; readonly yes: boolean },
  explain: readonly string[],
): Promise<true | ExitCode> {
  const { out, deps } = context;
  if (input.yes) return true;
  if (deps.prompt === null) {
    out.diagnostic(
      `browserhive templates ${input.command}: refusing without confirmation, and stdin is not a terminal.`,
    );
    out.diagnostic('Run it in a terminal, or pass --yes if you are scripting this deliberately.');
    return EXIT.fatal;
  }
  out.lines(explain);
  const answer = await deps.prompt(`Type the template's name to confirm: `);
  if (answer.trim() === input.name) return true;
  out.line('Aborted — nothing was changed.');
  return EXIT.fatal;
}

/** How waiting on an operation ended (an API failure is an exit code instead). */
type OperationOutcome = TemplateOperation | 'interrupt';

/**
 * Polls `GET /templates/operations/{id}` every {@link OPERATION_POLL_MS} until the operation is
 * done or failed, or Ctrl+C (the operation continues on the server).
 *
 * @returns The finished operation, `interrupt`, or an exit code after an API failure.
 */
async function waitForOperation(
  context: CommandContext,
  remote: RemoteTarget,
  operationId: string,
): Promise<OperationOutcome | ExitCode> {
  const { wait } = context.deps;
  let stopListening: () => void = () => undefined;
  const interrupt = new Promise<'interrupt'>((resolve) => {
    stopListening = wait.onInterrupt(() => resolve('interrupt'));
  });
  try {
    for (;;) {
      const path = `/templates/operations/${encodeURIComponent(operationId)}`;
      const result = await remoteCall(context, remote, 'GET', path);
      if (!result.ok) return result.code;
      const parsed = TemplateOperation.safeParse(result.json);
      if (!parsed.success) {
        context.out.diagnostic('browserhive: the server answered with an unexpected operation.');
        return EXIT.fatal;
      }
      if (parsed.data.state !== 'running') return parsed.data;
      const tick = wait.sleep(OPERATION_POLL_MS).then(() => 'tick' as const);
      if ((await Promise.race([interrupt, tick])) === 'interrupt') return 'interrupt';
    }
  } finally {
    stopListening();
  }
}

/** Starts an operation (202 `{operation_id}`) and waits for it. */
async function runOperation(
  context: CommandContext,
  remote: RemoteTarget,
  request: { readonly path: string; readonly body: unknown; readonly label: string },
): Promise<TemplateOperation | ExitCode> {
  const started = await remoteCall(context, remote, 'POST', request.path, request.body);
  if (!started.ok) return started.code;
  const accepted = TemplateOperationAccepted.safeParse(started.json);
  if (!accepted.success) {
    context.out.diagnostic('browserhive: the server answered with an unexpected operation.');
    return EXIT.fatal;
  }
  const id = accepted.data.operation_id;
  const outcome = await waitForOperation(context, remote, id);
  if (outcome === 'interrupt') {
    context.out.diagnostic(
      `Stopped waiting; the ${request.label} continues on the server (operation ${id}).`,
    );
    return EXIT.fatal;
  }
  if (typeof outcome === 'number') return outcome;
  if (outcome.state === 'failed') {
    const error = outcome.error ?? { code: 'INTERNAL_ERROR', message: 'the operation failed' };
    context.out.diagnostic(
      `browserhive: ${request.label} failed: [${error.code}] ${error.message}`,
    );
    return EXIT.fatal;
  }
  return outcome;
}

/** Sites that need the operator after a seed: signed out or challenged. */
function needsAttention(detail: TemplateDetailResponse): readonly string[] {
  return detail.sites
    .filter((site) => site.enabled)
    .filter((site) => site.health.state === 'signed_out' || site.health.state === 'challenged')
    .map((site) => site.site_id);
}

/**
 * Sends a checked storage state to `POST /templates/{id}/state?confirm=true`, waits for the
 * operation and prints the sites (shared by `seed` and `create --fromState`).
 *
 * @returns 0 when done, 2 when a site is signed out or challenged afterwards, 1 on a failure.
 */
export async function seedTemplate(
  context: CommandContext,
  target: { readonly remote: RemoteTarget; readonly templateId: string; readonly name: string },
  state: StateFile,
  json: boolean,
): Promise<ExitCode> {
  const { out } = context;
  const operation = await runOperation(context, target.remote, {
    path: `/templates/${target.templateId}/state?confirm=true`,
    body: state.body,
    label: 'seeding',
  });
  if (typeof operation === 'number') return operation;
  const detail = await fetchTemplateDetail(context, target.remote, target.templateId);
  if (typeof detail === 'number') return detail;
  const attention = needsAttention(detail);
  const code = attention.length === 0 ? EXIT.ok : EXIT.warnings;
  if (json) {
    out.json({ operation, template: detail.template, sites: detail.sites });
    return code;
  }
  const width = Math.max(...detail.sites.map((site) => site.site_id.length));
  for (const site of detail.sites.filter((s) => s.enabled)) {
    out.line(`${site.site_id.padEnd(width)}  ${healthText(site.health.state, out.style)}`);
  }
  const version = operation.version === undefined ? '' : ` as version ${operation.version}`;
  out.status('ok', `seeded ${target.name}${version}`, `template is ${detail.template.status}`);
  if (attention.length > 0) {
    out.status(
      'warn',
      `${attention.join(', ')} ${attention.length === 1 ? 'is' : 'are'} not signed in`,
      'sign in again from the dashboard, or seed a fresher state',
    );
  }
  return code;
}

/**
 * `templates seed <name> <file> [--yes]`: replaces the template's sign-ins with a storage-state
 * file (spec 13 §7.4).
 *
 * @returns 0 when done, 2 when a site is not signed in afterwards, 1 on a failure or refusal.
 */
export async function runTemplatesSeed(
  context: CommandContext,
  invocation: Of<'templates-seed'>,
): Promise<ExitCode> {
  const { remote, name } = invocation;
  const state = await readStateFile(context, invocation.file);
  if (typeof state === 'number') return state;
  const template = await findTemplate(context, remote, name);
  if (typeof template === 'number') return template;
  const confirmed = await confirmByName(context, { name, command: 'seed', yes: invocation.yes }, [
    `This replaces the sign-ins of template '${name}' (${template.status}) with ${invocation.file}: ${state.cookies} cookie(s), ${state.origins} origin(s).`,
    "Its browser restarts with the new state, and it becomes the template's newest version.",
  ]);
  if (confirmed !== true) return confirmed;
  return seedTemplate(
    context,
    { remote, templateId: template.template_id, name },
    state,
    invocation.json,
  );
}

/**
 * `templates restore <name> <version|latest> [--forceClose] [--yes]`: rolls the template back as an
 * operation that closes or waits for its sessions (spec 13 §3.12).
 *
 * @returns 0 when restored, 1 on a failure or refusal.
 */
export async function runTemplatesRestore(
  context: CommandContext,
  invocation: Of<'templates-restore'>,
): Promise<ExitCode> {
  const { out } = context;
  const { remote, name, version } = invocation;
  const template = await findTemplate(context, remote, name);
  if (typeof template === 'number') return template;
  const detail = await fetchTemplateDetail(context, remote, template.template_id);
  if (typeof detail === 'number') return detail;
  const what = version === 'latest' ? 'its rolling checkpoint' : `version ${version}`;
  const live = detail.sessions_live;
  const sessions =
    live === 0
      ? 'No session is using it.'
      : invocation.forceClose
        ? `Its ${live} live session(s) are closed at once (--forceClose).`
        : `It waits for its ${live} live session(s) to end, up to templateDrainTimeout (--forceClose closes them at once).`;
  const confirmed = await confirmByName(
    context,
    { name, command: 'restore', yes: invocation.yes },
    [
      `This restores template '${name}' to ${what}: its browser restarts with that state, saved as a new version.`,
      sessions,
    ],
  );
  if (confirmed !== true) return confirmed;
  if (!invocation.json && live > 0 && !invocation.forceClose) {
    out.line(`Waiting for ${live} session(s) to end… (Ctrl+C stops waiting; the restore goes on)`);
  }
  const operation = await runOperation(context, remote, {
    path: `/templates/${template.template_id}/versions/${version}/restore`,
    body: invocation.forceClose ? { force_close: true } : {},
    label: 'restore',
  });
  if (typeof operation === 'number') return operation;
  if (invocation.json) {
    out.json(operation);
    return EXIT.ok;
  }
  const written = operation.version === undefined ? '' : ` as version ${operation.version}`;
  const closed = operation.closed_sessions.length;
  out.status(
    'ok',
    `restored ${name} to ${what}${written}`,
    closed === 0 ? undefined : `${closed} session(s) closed`,
  );
  return EXIT.ok;
}
