/** @module interface/http/routes/session-ops — terminate / archive / unarchive / delete, shared by the single and bulk routes (spec 03 §4.2). */

import type { BulkSessionAction } from '@browserhive/contracts/http';
import type { RequestPrincipal } from '../../../domain/auth/principal.ts';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { HttpServices } from '../services.ts';
import { isOpenSession, type KnownSession, requireSession } from './common.ts';

async function audit(
  services: HttpServices,
  principal: RequestPrincipal,
  action: string,
  sessionId: string,
  now: number,
  details: Readonly<Record<string, unknown>> | null = null,
): Promise<void> {
  await services.repos.operatorActions.append({
    eventId: services.ids.eventId(),
    principalId: principal.subject,
    action,
    resourceKind: 'session',
    resourceId: sessionId,
    details,
    occurredAt: now,
  });
}

/** Terminates a live session; 409 `SESSION_NOT_LIVE` when it is not running. */
export async function terminateSession(
  services: HttpServices,
  principal: RequestPrincipal,
  sessionId: string,
  now: number,
): Promise<boolean> {
  const known = await requireSession(services, sessionId);
  if (!isOpenSession(known)) {
    throw new AppError(
      'SESSION_NOT_LIVE',
      { session_id: sessionId },
      { publicMessage: `Session '${sessionId}' is not live.` },
    );
  }
  const closed = await services.sessions.close(sessionId, 'operator');
  await audit(services, principal, 'terminate', sessionId, now);
  return closed;
}

function refuseLive(known: KnownSession): void {
  if (isOpenSession(known)) {
    throw new AppError(
      'SESSION_LIVE',
      { session_id: known.id },
      { publicMessage: `Session '${known.id}' is live; close it first.` },
    );
  }
}

/** Archives a finished session; 409 `SESSION_LIVE` while it runs. */
export async function archiveSession(
  services: HttpServices,
  principal: RequestPrincipal,
  sessionId: string,
  now: number,
): Promise<void> {
  const known = await requireSession(services, sessionId);
  refuseLive(known);
  await services.repos.sessions.archive(sessionId, now);
  await audit(services, principal, 'archive', sessionId, now);
  services.events.publish('session.removed', {
    type: 'session.removed',
    session_id: known.id,
    action: 'archived',
    at: now,
  });
}

/** Clears `archived_at`. */
export async function unarchiveSession(
  services: HttpServices,
  principal: RequestPrincipal,
  sessionId: string,
  now: number,
): Promise<void> {
  const known = await requireSession(services, sessionId);
  await services.repos.sessions.unarchive(sessionId);
  await audit(services, principal, 'unarchive', sessionId, now);
  services.events.publish('session.removed', {
    type: 'session.removed',
    session_id: known.id,
    action: 'unarchived',
    at: now,
  });
}

/** Terminates (when live) then hard-deletes rows and enqueues the session directory. */
export async function deleteSession(
  services: HttpServices,
  principal: RequestPrincipal,
  sessionId: string,
  now: number,
): Promise<{ rows: number; bytes: number }> {
  const known = await requireSession(services, sessionId);
  if (isOpenSession(known)) await services.sessions.close(sessionId, 'operator');
  const dir = services.sessionDirs.forSession(sessionId).root;
  const bytes = await services.files.sizeOf(dir);
  const result = await services.repos.sessions.delete(sessionId, dir);
  await audit(services, principal, 'delete', sessionId, now, { rows: result.rows, bytes });
  services.events.publish('session.removed', {
    type: 'session.removed',
    session_id: known.id,
    action: 'deleted',
    at: now,
  });
  return { rows: result.rows, bytes };
}

/** Runs one bulk action item. */
export async function runBulkSessionAction(
  services: HttpServices,
  principal: RequestPrincipal,
  action: BulkSessionAction,
  sessionId: string,
  now: number,
): Promise<void> {
  switch (action) {
    case 'terminate':
      await terminateSession(services, principal, sessionId, now);
      return;
    case 'archive':
      await archiveSession(services, principal, sessionId, now);
      return;
    case 'unarchive':
      await unarchiveSession(services, principal, sessionId, now);
      return;
    case 'delete':
      await deleteSession(services, principal, sessionId, now);
      return;
  }
}
