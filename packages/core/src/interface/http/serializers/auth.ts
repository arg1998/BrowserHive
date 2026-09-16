/** @module interface/http/serializers/auth — auth service views → wire (spec 03 §4.1). */

import type { ApiTokenSummary, AuthSessionSummary, MeResponse } from '@browserhive/contracts/http';
import type { z } from 'zod';
import type { AuthSessionView, MeView } from '../../../app/auth/session-ops.ts';
import type { ApiTokenView } from '../../../app/auth/token-ops.ts';

/** `GET /auth/me` body. */
export function meToWire(view: MeView): z.input<typeof MeResponse> {
  return {
    principal: {
      subject: view.principal.subject,
      kind: view.principal.kind,
      display: view.principal.display,
      scopes: [...view.principal.scopes],
      must_change_password: view.principal.mustChangePassword,
    },
    ...(view.session !== undefined && {
      session: {
        id_prefix: view.session.idPrefix,
        created_at: view.session.createdAt,
        last_seen_at: view.session.lastSeenAt,
        expires_at: view.session.expiresAt,
      },
    }),
  };
}

/** One operator session of the caller. */
export function authSessionToWire(view: AuthSessionView): z.input<typeof AuthSessionSummary> {
  return {
    id_prefix: view.idPrefix,
    created_at: view.createdAt,
    last_seen_at: view.lastSeenAt,
    user_agent: view.userAgent,
    ip: view.ip,
    current: view.current,
  };
}

/** One API token (never the secret). */
export function tokenToWire(view: ApiTokenView): z.input<typeof ApiTokenSummary> {
  return {
    credential_id: view.credentialId,
    public_prefix: view.publicPrefix,
    owner_kind: view.ownerKind,
    subject: view.subject,
    scopes: [...view.scopes],
    created_at: view.createdAt,
    last_used_at: view.lastUsedAt,
    expires_at: view.expiresAt,
  };
}
