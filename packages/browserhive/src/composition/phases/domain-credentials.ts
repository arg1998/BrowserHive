/** @module composition/phases/domain-credentials — the boot's credential steps (D-09, spec 13 T0f): the seed flow (first operator password, first agent token) and the warning about reserved subjects still in use. */

import type { Logger } from '@browserhive/core/runtime';
import {
  describeReservedSubjects,
  findReservedSubjects,
  hasReservedSubjects,
  serializeError,
} from '@browserhive/core/runtime';
import type { BootContext, SeedNotice } from '../context.ts';

/**
 * Spec 13 T0f: tokens issued before token creation refused reserved subjects keep working, so say
 * so once per boot, naming them, and let the operator revoke them. Nothing is revoked here. A
 * failed listing never fails the boot.
 */
export async function warnReservedSubjects(
  logger: Logger,
  auth: { listTokens: () => Promise<Parameters<typeof findReservedSubjects>[0]> },
  authTokens: readonly string[],
): Promise<void> {
  try {
    const findings = findReservedSubjects(await auth.listTokens(), authTokens);
    if (!hasReservedSubjects(findings)) return;
    logger.warn('reserved subjects in use', {
      detail: describeReservedSubjects(findings),
      tokens: findings.tokens.map((t) => ({
        subject: t.subject,
        credential_id: t.credentialId,
        public_prefix: t.publicPrefix,
      })),
      auth_token_names: [...findings.configNames],
    });
  } catch (err) {
    logger.warn('reserved check failed', { err: serializeError(err) });
  }
}

/**
 * Seed flow (D-09): the first http start with `admin=true` creates the operator with a one-time
 * password; `auth=token` without stored or configured tokens mints `agent-1`'s token. Secrets are
 * returned for the banner only (never logged). Nothing is seeded under stdio.
 */
export async function seedCredentials(
  ctx: BootContext,
  auth: {
    seedAdmin: () => Promise<SeedAdminResult>;
    seedAgentToken: () => Promise<SeedTokenResult>;
  },
): Promise<SeedNotice> {
  if (ctx.transport !== 'http') return { adminPassword: null, agentToken: null };
  let adminPassword: SeedNotice['adminPassword'] = null;
  if (ctx.config.admin) {
    const seed = await auth.seedAdmin();
    if (seed.seeded) {
      adminPassword = { password: seed.password.reveal(), path: seed.credentialsPath };
    }
  }
  let agentToken: SeedNotice['agentToken'] = null;
  if (ctx.config.auth === 'token') {
    const seed = await auth.seedAgentToken();
    if (seed.seeded) agentToken = { principalId: seed.principalId, token: seed.token.reveal() };
  }
  return { adminPassword, agentToken };
}

type SeedAdminResult =
  | { readonly seeded: false }
  | {
      readonly seeded: true;
      readonly password: { reveal(): string };
      readonly credentialsPath: string;
    };

type SeedTokenResult =
  | { readonly seeded: false }
  | { readonly seeded: true; readonly principalId: string; readonly token: { reveal(): string } };
