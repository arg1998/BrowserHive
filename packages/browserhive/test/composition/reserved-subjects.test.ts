/** @module test/composition/reserved-subjects.test — the boot warning for agent tokens that already act as a reserved subject (spec 13 T0f): logged once, names the token, revokes nothing. */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { bootServer, openStorageForCli } from '../../src/composition/index.ts';
import { warnReservedSubjects } from '../../src/composition/phases/build-domain.ts';
import { bootInputFor, tempDir } from './support.ts';

const quiet = {
  child: () => quiet,
  isLevelEnabled: () => false,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

/** A logger that records `warn` calls (message and fields). */
function recordingLogger() {
  const warnings: { message: string; fields: Record<string, unknown> | undefined }[] = [];
  const logger = {
    ...quiet,
    child: () => logger,
    warn: (message: string, fields?: Record<string, unknown>) => {
      warnings.push({ message, fields });
    },
  };
  return { logger, warnings };
}

const row = (subject: string, n: number) => ({
  credentialId: `cred-${n}`,
  publicPrefix: `pre${n}xxxx`,
  ownerKind: 'agent' as const,
  subject,
});

describe('warnReservedSubjects', () => {
  it('logs one warning naming every reserved token and authTokens name, never a token value', async () => {
    const { logger, warnings } = recordingLogger();
    await warnReservedSubjects(
      logger,
      { listTokens: async () => [row('ci-runner', 1), row('local', 2), row('template:x', 3)] },
      [`system:${'a'.repeat(32)}`, `bot:${'b'.repeat(32)}`],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('reserved subjects in use');
    expect(warnings[0]?.fields).toMatchObject({
      tokens: [
        { subject: 'local', credential_id: 'cred-2', public_prefix: 'pre2xxxx' },
        { subject: 'template:x', credential_id: 'cred-3', public_prefix: 'pre3xxxx' },
      ],
      auth_token_names: ['system'],
    });
    expect(JSON.stringify(warnings)).not.toContain('a'.repeat(32));
  });

  it('is silent when nothing is reserved, and a failed listing never throws', async () => {
    const { logger, warnings } = recordingLogger();
    await warnReservedSubjects(logger, { listTokens: async () => [row('ci-runner', 1)] }, []);
    expect(warnings).toEqual([]);
    await warnReservedSubjects(
      logger,
      {
        listTokens: () => Promise.reject(new Error('database is locked')),
      },
      [],
    );
    expect(warnings.map((w) => w.message)).toEqual(['reserved check failed']);
  });
});

describe('boot with a pre-upgrade token named local', () => {
  let dir = tempDir();
  afterEach(() => {
    dir.cleanup();
    dir = tempDir();
  });
  afterAll(() => dir.cleanup());

  it('warns once at startup and leaves the token active', async () => {
    // What an earlier version could create: an agent principal `local` with an api token.
    const storage = await openStorageForCli({
      dataDir: dir.path,
      readOnly: false,
      migrate: true,
      logger: quiet,
    });
    await storage.repos.principals.insert({
      principalId: 'local',
      kind: 'agent',
      display: 'Local',
      tenantId: null,
      mustChangePassword: false,
      createdAt: 1,
      updatedAt: 1,
      disabledAt: null,
    });
    await storage.repos.credentials.insert({
      credentialId: 'cred-local',
      principalId: 'local',
      kind: 'api_token',
      publicPrefix: 'loc4xxxx',
      secretHash: 'c'.repeat(64),
      display: 'Local',
      scopes: ['mcp:tools'],
      createdAt: 1,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    await storage.close();

    const input = bootInputFor(dir.path);
    const server = await bootServer(input);
    await server.stop();
    const lines = input.output.err.filter((l) => l.includes('reserved subjects in use'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cred-local');

    const after = await openStorageForCli({
      dataDir: dir.path,
      readOnly: true,
      migrate: false,
      logger: quiet,
    });
    expect((await after.auth.listTokens()).map((t) => t.credentialId)).toEqual(['cred-local']);
    await after.close();
  });
});
