/** @module interface/http/routes/auth-states — saved logins of every principal: list and the operator's audited delete (spec 03 §4.6.1, spec 02 §6). */

import {
  AuthStateParams,
  type AuthStateRow,
  AuthStatesResponse,
  DeleteAuthStateResponse,
} from '@browserhive/contracts/http';
import { type AuthStateRecord, authStateNotFound } from '../../../app/auth-states/store.ts';
import { defineRoute, reply } from '../define-route.ts';
import type { HttpServices } from '../services.ts';
import { requirePrincipal } from './common.ts';

const tags = ['auth-states'];

/** The source sessions' slugs, `null` for one whose record is gone (each id looked up once). */
async function slugsOf(
  services: HttpServices,
  records: readonly AuthStateRecord[],
): Promise<Map<string, string | null>> {
  const slugs = new Map<string, string | null>();
  for (const id of new Set(records.map((r) => r.source_session_id))) {
    const live = services.sessions.peek(id);
    slugs.set(id, live?.slug ?? (await services.repos.sessions.get(id))?.slug ?? null);
  }
  return slugs;
}

function toWire(record: AuthStateRecord, slugs: ReadonlyMap<string, string | null>): AuthStateRow {
  return {
    name: record.name,
    kind: record.kind,
    owner: record.owner,
    size: record.size,
    saved_at: record.saved_at,
    source_session_id: record.source_session_id,
    source_session_slug: slugs.get(record.source_session_id) ?? null,
  };
}

/** Saved-login routes. */
export const AUTH_STATE_ROUTES = [
  defineRoute({
    operationId: 'listAuthStates',
    tags,
    summary: "Every principal's saved logins (storage states and full profiles), newest first.",
    request: {},
    responses: { 200: AuthStatesResponse },
    async handler({ services, ctx }) {
      const records = await services.authStates.listAll();
      const slugs = await slugsOf(services, records);
      return reply(200, { data: records.map((r) => toWire(r, slugs)), now: ctx.now });
    },
  }),
  defineRoute({
    operationId: 'deleteAuthState',
    tags,
    summary:
      "Delete one principal's saved login with its identity seed. Sessions already restored from it keep running.",
    request: { params: AuthStateParams },
    responses: { 200: DeleteAuthStateResponse },
    errors: ['AUTH_STATE_NOT_FOUND'],
    async handler({ input, principal, services, ctx }) {
      const { owner, name } = input.params;
      const removed = await services.authStates.removeSnapshot(owner, name);
      if (removed === null) throw authStateNotFound(name);
      await services.repos.operatorActions.append({
        eventId: services.ids.eventId(),
        principalId: requirePrincipal(principal).subject,
        action: 'delete',
        resourceKind: 'auth_state',
        resourceId: `${owner}/${name}`,
        details: {
          owner,
          name,
          kind: removed.kind,
          size: removed.size,
          source_session_id: removed.source_session_id,
        },
        occurredAt: ctx.now,
      });
      const slugs = await slugsOf(services, [removed]);
      return reply(200, { ok: true, deleted: toWire(removed, slugs) });
    },
  }),
] as const;
