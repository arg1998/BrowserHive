/** @module test/helpers/fake-auth — deterministic hasher, CSPRNG, credentials file and view builders for auth tests (spec 09 §4). */

import type { AuthConfig, AuthDeps, AuthRequestView } from '../../src/app/auth/types.ts';
import { resolveAuthConfig } from '../../src/app/auth/types.ts';
import { sampleUnbiased } from '../../src/infra/auth/web-crypto-random.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import type { Secret } from '../../src/kernel/secret.ts';
import type { CredentialsFile } from '../../src/ports/credentials-file.ts';
import type { PasswordHasher } from '../../src/ports/password-hasher.ts';
import type { PrincipalRecord } from '../../src/ports/persistence/records-identity.ts';
import type { Random } from '../../src/ports/random.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeIdGenerator } from './fake-id-generator.ts';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Sequential event ids, random-looking opaque ids (so id prefixes differ between rows). */
export class AuthFakeIdGenerator extends FakeIdGenerator {
  private readonly random = createSeededRandom(0x1234_5678);

  override opaque(size: number): string {
    return this.random.token(ID_ALPHABET, size);
  }
}

import { createInMemoryAuthRepos, type InMemoryAuthRepos } from './in-memory-auth-repos.ts';

/** Transparent hasher: `fake$<secret>`; `weak$<secret>` hashes report `needsRehash`. */
export function createFakePasswordHasher(): PasswordHasher {
  return {
    hash: async (secret) => `fake$${secret}`,
    verify: async (secret, hash) => hash === `fake$${secret}` || hash === `weak$${secret}`,
    needsRehash: (hash) => hash.startsWith('weak$'),
  };
}

/** Seeded xorshift32 bytes — deterministic, good enough for token uniqueness in tests. */
export function createSeededRandom(seed = 0x9e3779b9): Random {
  let state = seed >>> 0 || 1;
  const bytes = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
  return { bytes, token: (alphabet, length) => sampleUnbiased(alphabet, length, bytes) };
}

/** In-memory credentials file that records writes and shreds. */
export interface FakeCredentialsFile extends CredentialsFile {
  readonly writes: string[];
  shredCount: number;
  content: string | null;
}

/** Builds a {@link FakeCredentialsFile}. */
export function createFakeCredentialsFile(
  path = '/data/admin/credentials.txt',
): FakeCredentialsFile {
  const file: FakeCredentialsFile = {
    path,
    writes: [],
    shredCount: 0,
    content: null,
    async write(password: Secret<string>) {
      file.content = `${password.reveal()}\n`;
      file.writes.push(file.content);
    },
    async shred() {
      file.shredCount += 1;
      file.content = null;
    },
    async exists() {
      return file.content !== null;
    },
  };
  return file;
}

/** Everything a test needs to drive the auth services. */
export interface AuthTestKit {
  readonly deps: AuthDeps;
  readonly repos: InMemoryAuthRepos;
  readonly clock: FakeClock;
  readonly ids: AuthFakeIdGenerator;
  readonly credentialsFile: FakeCredentialsFile;
  readonly logger: ReturnType<typeof createCollectingLogger>;
  readonly registered: string[];
  readonly published: { name: string; payload: unknown }[];
}

/** Builds an {@link AuthTestKit} with an optional config override. */
export function createAuthTestKit(config: Partial<AuthConfig> = {}): AuthTestKit {
  const repos = createInMemoryAuthRepos();
  const clock = new FakeClock();
  const ids = new AuthFakeIdGenerator();
  const credentialsFile = createFakeCredentialsFile();
  const logger = createCollectingLogger();
  const registered: string[] = [];
  const published: { name: string; payload: unknown }[] = [];
  const deps: AuthDeps = {
    repos,
    clock,
    ids,
    random: createSeededRandom(),
    hasher: createFakePasswordHasher(),
    credentialsFile,
    logger,
    config: resolveAuthConfig(config),
    bus: {
      publish: (name, payload) => {
        published.push({ name, payload });
      },
      subscribe: () => () => undefined,
      subscribeAll: () => () => undefined,
    },
    registerSecret: (literal) => {
      registered.push(literal);
    },
  };
  return { deps, repos, clock, ids, credentialsFile, logger, registered, published };
}

/** Inserts an operator principal with a `fake$<password>` credential. */
export async function seedOperator(
  kit: AuthTestKit,
  options: { password?: string; mustChangePassword?: boolean; principalId?: string } = {},
): Promise<PrincipalRecord> {
  const now = kit.clock.now();
  const principalId = options.principalId ?? 'admin';
  const record: PrincipalRecord = {
    principalId,
    kind: 'operator',
    display: principalId,
    tenantId: null,
    mustChangePassword: options.mustChangePassword ?? false,
    createdAt: now,
    updatedAt: now,
    disabledAt: null,
  };
  await kit.repos.principals.insert(record);
  await kit.repos.credentials.insert({
    credentialId: `cred-${principalId}`,
    principalId,
    kind: 'password',
    publicPrefix: null,
    secretHash: `fake$${options.password ?? 'correct horse battery'}`,
    display: null,
    scopes: [],
    createdAt: now,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  });
  return record;
}

/** Builds an {@link AuthRequestView} with loopback HTTP defaults. */
export function view(overrides: Partial<AuthRequestView> = {}): AuthRequestView {
  return {
    headers: {},
    query: {},
    transport: 'http',
    remoteLoopback: true,
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    ...overrides,
  };
}
