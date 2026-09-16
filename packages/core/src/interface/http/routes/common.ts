/** @module interface/http/routes/common — lookups shared by route files (session existence, vault configured). */

import { SessionId } from '@browserhive/contracts/ids';
import type { z } from 'zod';
import type { Session } from '../../../domain/session/session.ts';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { SessionListRow } from '../../../ports/persistence/records.ts';
import type { HttpServices } from '../services.ts';

/** A session as the operator routes see it: the stored row and/or the live aggregate. */
export interface KnownSession {
  readonly id: z.output<typeof SessionId>;
  readonly row: SessionListRow | null;
  readonly live: Session | undefined;
  readonly slug: string;
}

/** Finds a session in the registry or the store; throws 404 `SESSION_NOT_FOUND`. */
export async function requireSession(
  services: HttpServices,
  sessionId: string,
): Promise<KnownSession> {
  const live = services.sessions.peek(sessionId);
  const row = await services.repos.sessions.get(sessionId);
  if (live === undefined && row === null) {
    throw new AppError(
      'SESSION_NOT_FOUND',
      { session_id: sessionId },
      { publicMessage: `No browser session with id '${sessionId}'` },
    );
  }
  return {
    id: SessionId.parse(sessionId),
    row,
    live,
    slug: live?.slug ?? row?.slug ?? '',
  };
}

/** True while the session occupies a live browser (not closed, not crashed). */
export function isOpenSession(known: KnownSession): boolean {
  const kind = known.live?.state.kind;
  return kind !== undefined && kind !== 'closed' && kind !== 'crashed';
}

/** Throws 404 `VAULT_NOT_CONFIGURED` when the server runs with `vault=off`. */
export function requireVault(services: HttpServices): void {
  if (!services.vault.configured) throw new AppError('VAULT_NOT_CONFIGURED', {});
}

/** Throws when `principal` is null (routes that are never public). */
export function requirePrincipal<P>(principal: P | null): P {
  if (principal === null) throw new AppError('UNAUTHORIZED', {});
  return principal;
}
