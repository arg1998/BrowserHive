/** @module cli/commands/admin — `admin reset-password` and `admin tokens list | create <principal> | revoke <principal>` against the database or, with `--url`, a running server's REST API (spec 08 §7.1, D-09) */
import type { CommandContext, IssuedToken, TokenRow } from '../deps.ts';
import { EXIT, type ExitCode, type RemoteTarget } from '../invocation.ts';
import { remoteCreateToken, remoteListTokens, remoteRevokeToken } from './admin-remote.ts';
import { formatTimestamp, refuseWhileLocked, withStorage } from './common.ts';

const REMOTE_ALTERNATIVE =
  "use --url http://<host>:<port> with --token or --cookie to go through the server's API";

/**
 * Runs `admin reset-password`.
 *
 * @returns 0 on success, 3 while a server holds the data dir.
 */
export async function runResetPassword(
  context: CommandContext,
  dataDir: string,
  json: boolean,
): Promise<ExitCode> {
  const { deps, out } = context;
  const locked = refuseWhileLocked(context, dataDir, 'reset the admin password');
  if (locked !== null) return locked;
  const result = await withStorage(
    deps,
    { dataDir, readOnly: false, migrate: true, owner: 'admin reset-password' },
    (storage) => storage.resetPassword(),
  );
  if (json) {
    out.json({ password: result.password, credentials_path: result.credentialsPath });
    return EXIT.ok;
  }
  out.status('ok', 'admin password reset');
  out.line(`  password: ${out.style.bold(result.password)}`);
  out.line(`  saved to: ${result.credentialsPath} (0600)`);
  out.line(
    '  Shown once. Every dashboard session was signed out; the next login must set a new password.',
  );
  return EXIT.ok;
}

function tokenJson(row: TokenRow): Record<string, unknown> {
  return {
    credential_id: row.credentialId,
    public_prefix: row.publicPrefix,
    owner_kind: row.ownerKind,
    subject: row.subject,
    scopes: row.scopes,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    expires_at: row.expiresAt,
  };
}

async function listTokens(
  context: CommandContext,
  dataDir: string,
  remote: RemoteTarget | null,
): Promise<readonly TokenRow[] | ExitCode> {
  if (remote !== null) return remoteListTokens(context, remote);
  const locked = refuseWhileLocked(context, dataDir, 'open the database', REMOTE_ALTERNATIVE);
  if (locked !== null) return locked;
  return withStorage(
    context.deps,
    { dataDir, readOnly: true, migrate: false, owner: 'admin tokens list' },
    (storage) => storage.listTokens(),
  );
}

/**
 * Runs `admin tokens list`.
 *
 * @returns 0 on success.
 */
export async function runTokensList(
  context: CommandContext,
  dataDir: string,
  json: boolean,
  remote: RemoteTarget | null,
): Promise<ExitCode> {
  const { out } = context;
  const rows = await listTokens(context, dataDir, remote);
  if (typeof rows === 'number') return rows;
  if (json) {
    out.json(rows.map(tokenJson));
    return EXIT.ok;
  }
  if (rows.length === 0) {
    out.line("No API tokens. Create one with 'browserhive admin tokens create <principal>'.");
    return EXIT.ok;
  }
  out.table(
    [
      { header: 'PRINCIPAL' },
      { header: 'KIND' },
      { header: 'PREFIX' },
      { header: 'CREATED' },
      { header: 'LAST USED' },
      { header: 'EXPIRES' },
      { header: 'ID' },
    ],
    rows.map((row) => [
      out.style.bold(row.subject),
      row.ownerKind,
      row.publicPrefix,
      formatTimestamp(row.createdAt),
      formatTimestamp(row.lastUsedAt),
      row.expiresAt === null ? 'never' : formatTimestamp(row.expiresAt),
      out.style.dim(row.credentialId),
    ]),
  );
  return EXIT.ok;
}

/**
 * Runs `admin tokens create <principal>`; the plaintext is printed exactly once.
 *
 * @returns 0 on success.
 */
export async function runTokensCreate(
  context: CommandContext,
  input: {
    readonly dataDir: string;
    readonly principal: string;
    readonly expiresInMs: number | null;
    readonly json: boolean;
    readonly remote: RemoteTarget | null;
  },
): Promise<ExitCode> {
  const { out } = context;
  let issued: IssuedToken;
  if (input.remote !== null) {
    const result = await remoteCreateToken(
      context,
      input.remote,
      input.principal,
      input.expiresInMs,
    );
    if (typeof result === 'number') return result;
    issued = result;
  } else {
    const locked = refuseWhileLocked(
      context,
      input.dataDir,
      'open the database',
      REMOTE_ALTERNATIVE,
    );
    if (locked !== null) return locked;
    issued = await withStorage(
      context.deps,
      { dataDir: input.dataDir, readOnly: false, migrate: true, owner: 'admin tokens create' },
      (storage) =>
        storage.createToken({ principal: input.principal, expiresInMs: input.expiresInMs }),
    );
  }
  if (input.json) {
    out.json({
      credential_id: issued.credentialId,
      principal: issued.principalId,
      public_prefix: issued.publicPrefix,
      token: issued.token,
      expires_at: issued.expiresAt,
    });
    return EXIT.ok;
  }
  out.status('ok', `token created for ${issued.principalId}`, issued.credentialId);
  out.line(`  token:   ${out.style.bold(issued.token)}`);
  out.line(`  expires: ${issued.expiresAt === null ? 'never' : formatTimestamp(issued.expiresAt)}`);
  out.line('  Shown once; only its hash is stored. Send it as: Authorization: Bearer <token>');
  return EXIT.ok;
}

/**
 * Runs `admin tokens revoke <principal>`: every active token of that principal, or the one token
 * whose credential id or public prefix matches.
 *
 * @returns 0 when something was revoked, 1 when nothing matched.
 */
export async function runTokensRevoke(
  context: CommandContext,
  input: {
    readonly dataDir: string;
    readonly principal: string;
    readonly json: boolean;
    readonly remote: RemoteTarget | null;
  },
): Promise<ExitCode> {
  const { out, deps } = context;
  const pick = (rows: readonly TokenRow[]): readonly TokenRow[] => {
    const bySubject = rows.filter((row) => row.subject === input.principal);
    if (bySubject.length > 0) return bySubject;
    return rows.filter(
      (row) => row.credentialId === input.principal || row.publicPrefix === input.principal,
    );
  };
  let revoked: readonly TokenRow[];
  if (input.remote !== null) {
    const rows = await remoteListTokens(context, input.remote);
    if (typeof rows === 'number') return rows;
    revoked = pick(rows);
    for (const row of revoked) {
      const code = await remoteRevokeToken(context, input.remote, row.credentialId);
      if (code !== EXIT.ok) return code;
    }
  } else {
    const locked = refuseWhileLocked(
      context,
      input.dataDir,
      'open the database',
      REMOTE_ALTERNATIVE,
    );
    if (locked !== null) return locked;
    revoked = await withStorage(
      deps,
      { dataDir: input.dataDir, readOnly: false, migrate: false, owner: 'admin tokens revoke' },
      async (storage) => {
        const matched = pick(await storage.listTokens());
        for (const row of matched) await storage.revokeToken(row.credentialId);
        return matched;
      },
    );
  }
  if (input.json) {
    out.json({ revoked: revoked.map(tokenJson) });
    return revoked.length === 0 ? EXIT.fatal : EXIT.ok;
  }
  if (revoked.length === 0) {
    out.diagnostic(
      `browserhive: no active token matches '${input.principal}'. Run 'browserhive admin tokens list'.`,
    );
    return EXIT.fatal;
  }
  for (const row of revoked) {
    out.status('ok', `revoked ${row.publicPrefix}`, `${row.subject} · ${row.credentialId}`);
  }
  return EXIT.ok;
}
