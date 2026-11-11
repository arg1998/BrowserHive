/** @module cli/commands/templates-create — `browserhive templates create <name> …` (create, open the sign-in window on the server's machine, wait, finish; or seed `--fromState`) and `templates finish <name>` (spec 13 §7.2, §7.4, §11.5) */
import { StartRecordingResponse, TemplateResponse } from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation, type RemoteTarget } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';
import { findTemplate } from './templates.ts';
import {
  durationText,
  finishRecording,
  type RecordingTarget,
  waitForSignIns,
} from './templates-recording.ts';
import { readStateFile, seedTemplate } from './templates-state.ts';

type CreateInvocation = Extract<Invocation, { readonly command: 'templates-create' }>;
type FinishInvocation = Extract<Invocation, { readonly command: 'templates-finish' }>;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The server's host name when it is not this machine (`--url` names another host), else `null`.
 *
 * @returns The remote host name, or `null` for a loopback URL.
 */
export function remoteHostName(remote: RemoteTarget): string | null {
  let host: string;
  try {
    host = new URL(remote.url).hostname;
  } catch {
    return null;
  }
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.') ? null : host;
}

function finishHint(name: string): string {
  return `Complete it later with: browserhive templates finish ${name}`;
}

/** `POST /templates`: the created template's id, or an exit code after printing the failure. */
async function createTemplate(
  context: CommandContext,
  invocation: CreateInvocation,
): Promise<{ readonly id: string; readonly json: unknown } | ExitCode> {
  const result = await remoteCall(
    context,
    invocation.remote,
    'POST',
    '/templates',
    invocation.input,
  );
  if (!result.ok) return result.code;
  const parsed = TemplateResponse.safeParse(result.json);
  if (!parsed.success) {
    context.out.diagnostic('browserhive: the server answered with an unexpected template.');
    return EXIT.fatal;
  }
  return { id: parsed.data.template.template_id, json: parsed.data.template };
}

/** `POST …/recording`: opens the sign-in window on the server's machine. */
async function startRecording(context: CommandContext, target: RecordingTarget): Promise<ExitCode> {
  const { out } = context;
  const host = remoteHostName(target.remote);
  if (host !== null) out.diagnostic(`! This opens a window on ${host}, not on this device.`);
  const path = `/templates/${target.templateId}/recording`;
  const result = await remoteCall(context, target.remote, 'POST', path, {});
  if (result.ok && StartRecordingResponse.safeParse(result.json).success) return EXIT.ok;
  if (result.ok) out.diagnostic('browserhive: the server answered with an unexpected recording.');
  out.diagnostic(
    `Template ${target.name} was created and stays in setup: continue its sign-in from the dashboard, or delete it with 'browserhive templates rm ${target.name}'.`,
  );
  return EXIT.fatal;
}

function printGuidance(context: CommandContext, timeoutMs: number): void {
  context.out.lines([
    'A window opened on the BrowserHive machine with one tab per site.',
    'Sign in to each site in its tab. Type your passwords rather than pasting them, and check the address bar first.',
    `Press Enter here when you are signed in to every site (gives up after ${durationText(timeoutMs)}).`,
    '',
  ]);
}

/**
 * `templates create <name> --sites …`: creates the template, opens the sign-in window on the
 * server's machine, waits for the sign-ins (every site signed in, Enter, `--timeout` or Ctrl+C)
 * and finishes it. `--noLogin` stops after creating; `--fromState <file>` seeds the template from a
 * storage state instead of opening a window (spec 13 §7.4) and exits like `templates seed`.
 *
 * @returns 0 when every site is signed in, 2 when one is not or on timeout, 1 on an API failure
 * or Ctrl+C.
 */
export async function runTemplatesCreate(
  context: CommandContext,
  invocation: CreateInvocation,
): Promise<ExitCode> {
  const { out } = context;
  const { name, json } = invocation;
  // A file that cannot be seeded is refused before anything is created.
  const state =
    invocation.fromState === null ? null : await readStateFile(context, invocation.fromState);
  if (typeof state === 'number') return state;
  const created = await createTemplate(context, invocation);
  if (typeof created === 'number') return created;
  if (json && invocation.noLogin) out.json(created.json);
  if (!json) out.status('ok', `created template ${name} (${created.id})`);
  if (invocation.noLogin) return EXIT.ok;
  if (state !== null) {
    const seeded = await seedTemplate(
      context,
      { remote: invocation.remote, templateId: created.id, name },
      state,
      json,
    );
    if (seeded === EXIT.fatal) {
      out.diagnostic(
        `Template ${name} was created and stays in setup: seed it again with 'browserhive templates seed ${name} <file>', or delete it with 'browserhive templates rm ${name}'.`,
      );
    }
    return seeded;
  }
  const target: RecordingTarget = { remote: invocation.remote, templateId: created.id, name, json };
  const started = await startRecording(context, target);
  if (started !== EXIT.ok) return started;
  if (!json) printGuidance(context, invocation.timeoutMs);
  const outcome = await waitForSignIns(context, target, invocation.timeoutMs);
  if (typeof outcome === 'number') {
    out.diagnostic(finishHint(name));
    return outcome;
  }
  if (outcome === 'timeout') {
    out.diagnostic(
      `Timed out after ${durationText(invocation.timeoutMs)}; template ${name} stays in setup. ${finishHint(name)}`,
    );
    return EXIT.warnings;
  }
  if (outcome === 'interrupt') {
    out.diagnostic(`Stopped waiting; the sign-in window stays open. ${finishHint(name)}`);
    return EXIT.fatal;
  }
  return finishRecording(context, target);
}

/**
 * `templates finish <name>`: completes a template left in setup (confirms its sites, offers to
 * remove unlisted sign-ins, sets it ready).
 *
 * @returns 0 when every site is signed in, 2 when one is not, 1 on an API failure.
 */
export async function runTemplatesFinish(
  context: CommandContext,
  invocation: FinishInvocation,
): Promise<ExitCode> {
  const { remote, name, json } = invocation;
  const template = await findTemplate(context, remote, name);
  if (typeof template === 'number') return template;
  return finishRecording(context, { remote, templateId: template.template_id, name, json });
}
