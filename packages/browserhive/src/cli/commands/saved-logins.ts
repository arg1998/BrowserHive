/** @module cli/commands/saved-logins — `browserhive saved-logins list | rm <name> [--owner <subject>]`: every principal's saved logins over a running server's REST API (spec 08 §7.1, spec 03 §4.6.1) */
import {
  type AuthStateRow,
  AuthStatesResponse,
  DeleteAuthStateResponse,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type RemoteTarget } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';
import { formatTimestamp, size } from './common.ts';

const KIND_TEXT: Readonly<Record<AuthStateRow['kind'], string>> = {
  storage: 'cookies & storage',
  profile: 'full profile',
};

async function listSavedLogins(
  context: CommandContext,
  remote: RemoteTarget,
): Promise<readonly AuthStateRow[] | ExitCode> {
  const result = await remoteCall(context, remote, 'GET', '/auth-states');
  if (!result.ok) return result.code;
  const parsed = AuthStatesResponse.safeParse(result.json);
  if (!parsed.success) {
    context.out.diagnostic('browserhive: the server answered with an unexpected saved-login list.');
    return EXIT.fatal;
  }
  return parsed.data.data;
}

/**
 * `saved-logins list`: every principal's saved logins, newest first.
 *
 * @returns The exit code.
 */
export async function runSavedLoginsList(
  context: CommandContext,
  remote: RemoteTarget,
  json: boolean,
): Promise<ExitCode> {
  const { out } = context;
  const rows = await listSavedLogins(context, remote);
  if (typeof rows === 'number') return rows;
  if (json) {
    out.json(rows);
    return EXIT.ok;
  }
  if (rows.length === 0) {
    out.line('No saved logins. Agents save them with save_storage_state or save_full_profile.');
    return EXIT.ok;
  }
  out.table(
    [
      { header: 'NAME' },
      { header: 'KIND' },
      { header: 'OWNER' },
      { header: 'SIZE' },
      { header: 'SAVED' },
      { header: 'SOURCE SESSION' },
    ],
    rows.map((r) => [
      out.style.bold(r.name),
      KIND_TEXT[r.kind],
      r.owner,
      size(r.size),
      formatTimestamp(r.saved_at),
      r.source_session_slug === null
        ? `${r.source_session_id} ${out.style.dim('(deleted)')}`
        : r.source_session_id,
    ]),
  );
  return EXIT.ok;
}

/**
 * `saved-logins rm <name> [--owner <subject>]`. Without `--owner`, the one principal that has a
 * saved login of that name; several such principals is an error that names them.
 *
 * @returns The exit code.
 */
export async function runSavedLoginsRemove(
  context: CommandContext,
  remote: RemoteTarget,
  name: string,
  owner: string | null,
  json: boolean,
): Promise<ExitCode> {
  const { out } = context;
  let target = owner;
  if (target === null) {
    const rows = await listSavedLogins(context, remote);
    if (typeof rows === 'number') return rows;
    const owners = rows.filter((r) => r.name === name).map((r) => r.owner);
    if (owners.length === 0) {
      out.diagnostic(`browserhive: no saved login named '${name}'.`);
      return EXIT.fatal;
    }
    if (owners.length > 1) {
      out.diagnostic(
        `browserhive: ${owners.length} principals have a saved login named '${name}' (${owners.join(', ')}). Pass --owner <subject>.`,
      );
      return EXIT.fatal;
    }
    target = owners[0] ?? null;
  }
  if (target === null) return EXIT.fatal;
  const result = await remoteCall(
    context,
    remote,
    'DELETE',
    `/auth-states/${encodeURIComponent(target)}/${encodeURIComponent(name)}`,
  );
  if (!result.ok) return result.code;
  const parsed = DeleteAuthStateResponse.safeParse(result.json);
  if (!parsed.success) {
    out.diagnostic('browserhive: the server answered with an unexpected delete result.');
    return EXIT.fatal;
  }
  if (json) out.json(parsed.data.deleted);
  else
    out.status(
      'ok',
      `deleted saved login ${name} of ${target}`,
      `${KIND_TEXT[parsed.data.deleted.kind]}, ${size(parsed.data.deleted.size)}`,
    );
  return EXIT.ok;
}
