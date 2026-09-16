/** @module cli/commands/admin-remote — `admin tokens` over a running server's REST API (`--url` with a bearer or the dashboard cookie) */
import {
  API_PREFIX,
  ApiTokenList,
  CreateTokenResponse,
  ProblemDetails,
} from '@browserhive/contracts/http';
import type { CommandContext, IssuedToken, TokenRow } from '../deps.ts';
import { EXIT, type ExitCode, type RemoteTarget } from '../invocation.ts';

/** Dashboard session cookie name (spec 03 §3.3). */
const SESSION_COOKIE = 'browserhive_session';

function headers(remote: RemoteTarget, withBody: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    ...(withBody && { 'content-type': 'application/json' }),
    ...(remote.token !== undefined && { authorization: `Bearer ${remote.token}` }),
    ...(remote.cookie !== undefined && { cookie: `${SESSION_COOKIE}=${remote.cookie}` }),
  };
}

async function call(
  context: CommandContext,
  remote: RemoteTarget,
  method: string,
  path: string,
  body?: unknown,
): Promise<
  { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly code: ExitCode }
> {
  const url = `${remote.url}${API_PREFIX}${path}`;
  let response: Awaited<ReturnType<CommandContext['deps']['http']>>;
  try {
    response = await context.deps.http(url, {
      method,
      headers: headers(remote, body !== undefined),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'request failed';
    context.out.diagnostic(`browserhive: cannot reach ${url}: ${reason}`);
    return { ok: false, code: EXIT.fatal };
  }
  if (response.status >= 200 && response.status < 300) {
    const text = await response.text();
    if (text === '') return { ok: true, json: null };
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      context.out.diagnostic(
        `browserhive: ${url} answered ${response.status} with a non-JSON body.`,
      );
      return { ok: false, code: EXIT.fatal };
    }
  }
  const text = await response.text();
  let problem: ProblemDetails | null = null;
  try {
    const parsed = ProblemDetails.safeParse(JSON.parse(text));
    problem = parsed.success ? parsed.data : null;
  } catch {
    problem = null;
  }
  const detail =
    problem === null
      ? `HTTP ${response.status}`
      : `[${problem.code}] ${problem.detail ?? problem.title}${problem.hint === undefined ? '' : ` ${problem.hint}`}`;
  context.out.diagnostic(`browserhive: ${method} ${url} failed: ${detail}`);
  if (response.status === 401 || response.status === 403) {
    context.out.diagnostic(
      'Pass an operator bearer with --token, or the dashboard session cookie with --cookie.',
    );
  }
  return { ok: false, code: EXIT.fatal };
}

/**
 * `GET /api/v1/auth/tokens`.
 *
 * @returns The rows, or an exit code after printing the failure.
 */
export async function remoteListTokens(
  context: CommandContext,
  remote: RemoteTarget,
): Promise<readonly TokenRow[] | ExitCode> {
  const result = await call(context, remote, 'GET', '/auth/tokens');
  if (!result.ok) return result.code;
  const parsed = ApiTokenList.safeParse(result.json);
  if (!parsed.success) {
    context.out.diagnostic('browserhive: the server answered with an unexpected token list shape.');
    return EXIT.fatal;
  }
  return parsed.data.data.map((row) => ({
    credentialId: row.credential_id,
    publicPrefix: row.public_prefix,
    ownerKind: row.owner_kind,
    subject: row.subject,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  }));
}

/**
 * `POST /api/v1/auth/tokens` for an agent principal, then reads the row back for its prefix.
 *
 * @returns The issued token, or an exit code after printing the failure.
 */
export async function remoteCreateToken(
  context: CommandContext,
  remote: RemoteTarget,
  principal: string,
  expiresInMs: number | null,
): Promise<IssuedToken | ExitCode> {
  const result = await call(context, remote, 'POST', '/auth/tokens', {
    owner_kind: 'agent',
    display: principal,
    ...(expiresInMs !== null && { expires_in_ms: expiresInMs }),
  });
  if (!result.ok) return result.code;
  const parsed = CreateTokenResponse.safeParse(result.json);
  if (!parsed.success) {
    context.out.diagnostic('browserhive: the server answered with an unexpected token shape.');
    return EXIT.fatal;
  }
  const rows = await remoteListTokens(context, remote);
  const row =
    typeof rows === 'number'
      ? undefined
      : rows.find((candidate) => candidate.credentialId === parsed.data.credential_id);
  return {
    credentialId: parsed.data.credential_id,
    principalId: row?.subject ?? principal,
    publicPrefix: row?.publicPrefix ?? '',
    token: parsed.data.token,
    expiresAt: row?.expiresAt ?? null,
  };
}

/**
 * `DELETE /api/v1/auth/tokens/{credential_id}`.
 *
 * @returns 0 on success, otherwise the exit code after printing the failure.
 */
export async function remoteRevokeToken(
  context: CommandContext,
  remote: RemoteTarget,
  credentialId: string,
): Promise<ExitCode> {
  const result = await call(
    context,
    remote,
    'DELETE',
    `/auth/tokens/${encodeURIComponent(credentialId)}`,
  );
  return result.ok ? EXIT.ok : result.code;
}
