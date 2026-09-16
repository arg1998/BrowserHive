/** @module app/vault/vault-service.test — configuration, backend ops, groups/items, bindings and policies CRUD with versions, export/import, tester */

import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeVaultBackend } from '../../../test/helpers/fake-vault-backend.ts';
import { createVaultRepos } from '../../../test/helpers/in-memory-vault-repos.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import type { VaultBackend } from '../../ports/vault-backend.ts';
import { VaultService } from './vault-service.ts';

function harness(backend: VaultBackend = new FakeVaultBackend()) {
  const clock = new FakeClock(5_000);
  const repos = createVaultRepos();
  const service = new VaultService({
    backend,
    broker: null,
    bindings: repos.bindings,
    policies: repos.policies,
    audit: repos.audit,
    confirm: null,
    clock,
    logger: createCollectingLogger(),
  });
  return { clock, repos, service };
}

describe('VaultService — configuration', () => {
  it('every backend-facing method throws VAULT_NOT_CONFIGURED when vault=off', async () => {
    const { service } = harness(new FakeVaultBackend({ kind: 'off' }));
    expect(service.configured).toBe(false);
    await expect(service.overview()).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
    await expect(service.status()).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
    await expect(service.sync()).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
    await expect(service.unlock({ token: 'x' })).rejects.toMatchObject({
      code: 'VAULT_NOT_CONFIGURED',
    });
    await expect(
      service.fill(
        { entryName: 'x', usernameSelector: '#u', passwordSelector: '#p' },
        {
          session: { sessionId: 's', slug: 's', disableEvaluate: false, vaultEnabled: true },
          page: { url: () => '', fill: async () => undefined, click: async () => undefined },
          tracing: null,
          principal: 'local',
        },
      ),
    ).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
  });

  it('overview never shells out and reflects the cached lock state; status/unlock/lock update it', async () => {
    const backend = new FakeVaultBackend();
    backend.unlocked = false;
    const { service } = harness(backend);
    const before = await service.overview();
    expect(backend.calls).toEqual([]);
    expect(before).toMatchObject({
      backend: 'bitwarden',
      unlocked: false,
      unlock: { required: true, mode: 'token', hint: 'fake hint' },
      bindingsCount: 0,
      policiesCount: 0,
      now: 5_000,
    });
    expect((await service.status()).unlocked).toBe(false);
    await expect(service.unlock({ token: 'wrong' })).rejects.toMatchObject({
      code: 'VAULT_UNLOCK_FAILED',
      details: { mode: 'token' },
    });
    await expect(service.unlock({ passphrase: 'correct-horse' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ path: 'token' }] },
    });
    expect(backend.calls).not.toContain('unlock:passphrase');
    await service.unlock({ token: 'fake-session-token' });
    expect((await service.overview()).unlocked).toBe(true);
    await expect(service.unlock({})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await service.sync()).toEqual({ items: 1, groups: 1, syncedAt: 5_000 });
    service.lock();
    expect((await service.overview()).unlocked).toBe(false);
    await expect(service.sync()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  it('groups and items compose backend inventory with bindings and policies', async () => {
    const backend = new FakeVaultBackend();
    backend.groups = [
      { id: 'f1', name: 'Work' },
      { id: 'f2', name: 'Work' },
      { id: null, name: 'No Folder' },
    ];
    backend.entries = [
      { id: 'i1', name: 'GitHub', groupId: 'f1', uris: ['https://github.com'] },
      { id: 'i2', name: 'Other', groupId: null, uris: [] },
    ];
    const { service } = harness(backend);
    await service.admin.putBinding('work.github', {
      itemName: 'GitHub',
      itemId: 'i1',
      groupId: 'f1',
    });
    await service.admin.putPolicy('f1', { accessMode: 'allow_all' });
    const groups = await service.groups();
    expect(
      groups.groups.map((g) => [
        g.groupId,
        g.itemCount,
        g.boundCount,
        g.policy?.accessMode ?? null,
      ]),
    ).toEqual([
      ['f1', 1, 1, 'allow_all'],
      ['f2', 0, 0, null],
      [null, 1, 0, null],
    ]);
    expect(groups.duplicates).toEqual([{ groupId: 'f1', name: 'Work', ids: ['f1', 'f2'] }]);
    const items = await service.items();
    expect(items).toEqual([
      {
        itemId: 'i2',
        name: 'Other',
        groupId: null,
        loginUris: [],
        handle: 'no-folder.other',
        bound: false,
      },
      {
        itemId: 'i1',
        name: 'GitHub',
        groupId: 'f1',
        loginUris: ['https://github.com'],
        handle: 'work.github',
        bound: true,
      },
    ]);
    expect((await service.items({ q: 'git' })).map((i) => i.itemId)).toEqual(['i1']);
  });
});

describe('VaultService.admin — bindings CRUD with optimistic versions', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('creates, updates with If-Match, conflicts on a stale version, deletes', async () => {
    await expect(h.service.admin.putBinding('Bad Handle', { itemName: 'x' })).rejects.toMatchObject(
      { code: 'VALIDATION_FAILED' },
    );
    await expect(h.service.admin.putBinding('gh', {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const created = await h.service.admin.putBinding('gh', {
      itemName: 'GitHub',
      allowedOrigins: ['GitHub.com'],
    });
    expect(created).toMatchObject({
      handle: 'gh',
      title: 'gh',
      version: 1,
      allowedOrigins: ['github.com'],
      createdAt: 5_000,
    });
    await h.clock.advance(10);
    const updated = await h.service.admin.putBinding('gh', { dashboardConfirm: true }, 1);
    expect(updated).toMatchObject({
      version: 2,
      itemName: 'GitHub',
      dashboardConfirm: true,
      createdAt: 5_000,
      updatedAt: 5_010,
    });
    await expect(h.service.admin.putBinding('gh', { title: 'stale' }, 1)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { current_version: 2 },
    });
    expect(await h.service.admin.getBinding('gh')).toMatchObject({ version: 2 });
    expect((await h.service.admin.listBindings({})).items).toHaveLength(1);
    expect(await h.service.admin.deleteBinding('gh')).toBe(true);
    expect(await h.service.admin.deleteBinding('gh')).toBe(false);
    await expect(h.service.admin.getBinding('gh')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('group policies follow the same version rules and address the ungrouped bucket by key', async () => {
    const created = await h.service.admin.putPolicy('__ungrouped__', { accessMode: 'reject_all' });
    expect(created).toMatchObject({
      groupKey: '__ungrouped__',
      groupId: null,
      accessMode: 'reject_all',
      version: 1,
    });
    const updated = await h.service.admin.putPolicy(
      '__ungrouped__',
      { sessionSlugGlobs: ['a-*', 'a-*'] },
      1,
    );
    expect(updated).toMatchObject({
      accessMode: 'reject_all',
      sessionSlugGlobs: ['a-*'],
      version: 2,
    });
    await expect(
      h.service.admin.putPolicy('__ungrouped__', { accessMode: 'manual' }, 1),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await h.service.admin.listPolicies()).toHaveLength(1);
    expect(await h.service.admin.deletePolicy('__ungrouped__')).toBe(true);
  });

  it('export → import round-trips the v3 document (merge and replace)', async () => {
    await h.service.admin.putBinding('gh', {
      itemName: 'GitHub',
      allowedOrigins: ['*.github.com'],
      authorizedSessionSlugs: ['agent-*'],
      authorizedPrincipals: ['p-1'],
      redactUsername: true,
    });
    await h.service.admin.putPolicy('f1', { accessMode: 'allow_all', sessionSlugGlobs: ['x-*'] });
    const doc = await h.service.admin.exportDocument();
    expect(doc).toEqual({
      version: 3,
      bindings: [
        {
          handle: 'gh',
          title: 'gh',
          item_name: 'GitHub',
          item_id: '',
          group_id: null,
          allowed_origins: ['*.github.com'],
          authorized_principals: ['p-1'],
          authorized_session_slugs: ['agent-*'],
          allow_all_sessions: false,
          redact_username: true,
          require_no_evaluate: false,
          dashboard_confirm: false,
        },
      ],
      policies: [
        {
          group_id: 'f1',
          access_mode: 'allow_all',
          allow_all_sessions: false,
          session_slug_globs: ['x-*'],
          authorized_principals: [],
          dashboard_confirm: false,
          require_no_evaluate: false,
          redact_username: false,
        },
      ],
    });
    const fresh = harness();
    expect(
      await fresh.service.admin.importDocument(JSON.parse(JSON.stringify(doc)), 'merge'),
    ).toEqual({ bindings: 1, policies: 1 });
    expect(await fresh.service.admin.exportDocument()).toEqual(doc);
    await fresh.service.admin.putBinding('extra', { itemName: 'Extra' });
    expect(await fresh.service.admin.importDocument(doc, 'replace')).toEqual({
      bindings: 1,
      policies: 1,
    });
    expect((await fresh.service.admin.exportDocument()).bindings.map((b) => b.handle)).toEqual([
      'gh',
    ]);
    await expect(
      fresh.service.admin.importDocument({ version: 2, bindings: [] }, 'merge'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('tester reports would_fill / blocked per binding for a url and optional subject', async () => {
    await h.service.admin.putBinding('gh', {
      itemName: 'GitHub',
      allowedOrigins: ['*.github.com'],
      authorizedSessionSlugs: ['agent-*'],
      authorizedPrincipals: ['p-1'],
    });
    await h.service.admin.putBinding('li', {
      itemName: 'LinkedIn',
      allowedOrigins: ['linkedin.com'],
      allowAllSessions: true,
    });
    await h.service.admin.putBinding('rej', {
      itemName: 'Rejected',
      groupId: 'f9',
      allowedOrigins: ['*.github.com'],
      allowAllSessions: true,
    });
    await h.service.admin.putPolicy('f9', { accessMode: 'reject_all' });
    expect(await h.service.admin.tester({ url: 'https://www.github.com/login' })).toEqual({
      wouldFill: ['gh'],
      blocked: [
        { handle: 'li', reason: 'origin_mismatch' },
        { handle: 'rej', reason: 'not_authorized' },
      ],
    });
    expect(
      (await h.service.admin.tester({ url: 'https://www.github.com/login', sessionSlug: 'other' }))
        .blocked,
    ).toContainEqual({ handle: 'gh', reason: 'not_authorized' });
    expect(
      (
        await h.service.admin.tester({
          url: 'https://www.github.com/login',
          sessionSlug: 'agent-1',
          principal: 'p-2',
        })
      ).wouldFill,
    ).toEqual([]);
    expect(
      (
        await h.service.admin.tester({
          url: 'https://www.github.com/login',
          sessionSlug: 'agent-1',
          principal: 'p-1',
        })
      ).wouldFill,
    ).toEqual(['gh']);
  });
});
