/** @module test/helpers/in-memory-auth-repos — Map-backed fakes of the five identity repositories (spec 09 §3.2 Auth). */

import type {
  AuthEventRepository,
  AuthSessionRepository,
  CredentialRepository,
  GrantRepository,
  PrincipalPatch,
  PrincipalRepository,
} from '../../src/ports/persistence/identity.ts';
import type {
  AuthEventRecord,
  AuthSessionRecord,
  CredentialRecord,
  GrantRecord,
  PrincipalRecord,
} from '../../src/ports/persistence/records-identity.ts';

/** The five repositories plus direct access to their maps for assertions. */
export interface InMemoryAuthRepos {
  readonly principals: PrincipalRepository;
  readonly credentials: CredentialRepository;
  readonly authSessions: AuthSessionRepository;
  readonly grants: GrantRepository;
  readonly authEvents: AuthEventRepository;
  readonly tables: {
    readonly principals: Map<string, PrincipalRecord>;
    readonly credentials: Map<string, CredentialRecord>;
    readonly authSessions: Map<string, AuthSessionRecord>;
    readonly grants: Map<string, GrantRecord>;
    readonly authEvents: AuthEventRecord[];
  };
}

/** Builds a fresh set of in-memory identity repositories. */
export function createInMemoryAuthRepos(): InMemoryAuthRepos {
  const principals = new Map<string, PrincipalRecord>();
  const credentials = new Map<string, CredentialRecord>();
  const authSessions = new Map<string, AuthSessionRecord>();
  const grants = new Map<string, GrantRecord>();
  const authEvents: AuthEventRecord[] = [];

  const principalRepo: PrincipalRepository = {
    async insert(record) {
      if (!principals.has(record.principalId)) principals.set(record.principalId, record);
    },
    async get(id) {
      return principals.get(id) ?? null;
    },
    async list(kind) {
      return [...principals.values()]
        .filter((p) => kind === undefined || p.kind === kind)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async update(id, patch: PrincipalPatch) {
      const current = principals.get(id);
      if (current === undefined) return false;
      principals.set(id, { ...current, ...patch });
      return true;
    },
  };

  const credentialRepo: CredentialRepository = {
    async insert(record) {
      if (!credentials.has(record.credentialId)) credentials.set(record.credentialId, record);
    },
    async get(id) {
      return credentials.get(id) ?? null;
    },
    async findByPrefix(prefix) {
      return (
        [...credentials.values()].find((c) => c.publicPrefix === prefix && c.revokedAt === null) ??
        null
      );
    },
    async listByPrincipal(principalId, kind) {
      return [...credentials.values()].filter(
        (c) => c.principalId === principalId && (kind === undefined || c.kind === kind),
      );
    },
    async listActive(kind) {
      return [...credentials.values()].filter((c) => c.kind === kind && c.revokedAt === null);
    },
    async replaceSecret(id, secretHash) {
      const current = credentials.get(id);
      if (current === undefined) return false;
      credentials.set(id, { ...current, secretHash });
      return true;
    },
    async touch(id, at) {
      const current = credentials.get(id);
      if (current !== undefined) credentials.set(id, { ...current, lastUsedAt: at });
    },
    async revoke(id, at) {
      const current = credentials.get(id);
      if (current === undefined || current.revokedAt !== null) return false;
      credentials.set(id, { ...current, revokedAt: at });
      return true;
    },
  };

  const authSessionRepo: AuthSessionRepository = {
    async insert(record) {
      if (!authSessions.has(record.authSessionId)) authSessions.set(record.authSessionId, record);
    },
    async get(id) {
      return authSessions.get(id) ?? null;
    },
    async findByTokenHash(tokenHash, now) {
      return (
        [...authSessions.values()].find(
          (s) => s.tokenHash === tokenHash && s.revokedAt === null && s.expiresAt > now,
        ) ?? null
      );
    },
    async listActive(principalId) {
      return [...authSessions.values()]
        .filter((s) => s.principalId === principalId && s.revokedAt === null)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    async touch(id, at, expiresAt) {
      const current = authSessions.get(id);
      if (current !== undefined) {
        authSessions.set(id, {
          ...current,
          lastSeenAt: at,
          ...(expiresAt !== undefined && { expiresAt }),
        });
      }
    },
    async revoke(id, at) {
      const current = authSessions.get(id);
      if (current === undefined || current.revokedAt !== null) return false;
      authSessions.set(id, { ...current, revokedAt: at });
      return true;
    },
    async revokeAll(principalId, at, keep) {
      let count = 0;
      for (const [id, s] of authSessions) {
        if (s.principalId !== principalId || s.revokedAt !== null || id === keep) continue;
        authSessions.set(id, { ...s, revokedAt: at });
        count += 1;
      }
      return count;
    },
    async pruneExpired(before) {
      let count = 0;
      for (const [id, s] of authSessions) {
        if (s.expiresAt < before || (s.revokedAt !== null && s.revokedAt < before)) {
          authSessions.delete(id);
          count += 1;
        }
      }
      return count;
    },
  };

  const grantRepo: GrantRepository = {
    async insert(record) {
      if (!grants.has(record.grantId)) grants.set(record.grantId, record);
    },
    async findByTokenHash(tokenHash, now) {
      return (
        [...grants.values()].find((g) => g.tokenHash === tokenHash && g.expiresAt > now) ?? null
      );
    },
    async markUsed(id, at) {
      const current = grants.get(id);
      if (current !== undefined) grants.set(id, { ...current, usedAt: at });
    },
    async pruneExpired(before) {
      let count = 0;
      for (const [id, g] of grants) {
        if (g.expiresAt < before) {
          grants.delete(id);
          count += 1;
        }
      }
      return count;
    },
  };

  const authEventRepo: AuthEventRepository = {
    async append(event) {
      const seq = authEvents.length + 1;
      authEvents.push({ ...event, seq });
      return seq;
    },
    async list(query) {
      const items = [...authEvents]
        .reverse()
        .filter((e) => query.principalId === undefined || e.principalId === query.principalId)
        .filter((e) => query.types === undefined || query.types.includes(e.type))
        .slice(0, query.limit ?? 50);
      return { items, nextCursor: null };
    },
  };

  return {
    principals: principalRepo,
    credentials: credentialRepo,
    authSessions: authSessionRepo,
    grants: grantRepo,
    authEvents: authEventRepo,
    tables: { principals, credentials, authSessions, grants, authEvents },
  };
}
