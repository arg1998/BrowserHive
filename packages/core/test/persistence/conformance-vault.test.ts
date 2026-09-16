/** @module test/persistence/conformance-vault.test — vault bindings and group policies (versions, import/export). */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import type {
  VaultBindingRecord,
  VaultGroupPolicyRecord,
} from '../../src/ports/persistence/records.ts';
import { openMemory, type TestDb } from './setup.ts';

let t: TestDb;
beforeEach(async () => {
  t = await openMemory();
});
afterEach(async () => {
  await t.close();
});

const binding: VaultBindingRecord = {
  handle: 'github',
  tenantId: null,
  title: 'GitHub',
  itemName: 'github.com',
  itemId: 'i1',
  groupId: 'g1',
  allowedOrigins: ['https://github.com'],
  authorizedPrincipals: ['local'],
  authorizedSessionSlugs: ['*'],
  allowAllSessions: false,
  redactUsername: true,
  requireNoEvaluate: true,
  dashboardConfirm: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};
const policy: VaultGroupPolicyRecord = {
  groupKey: 'g1',
  groupId: 'g1',
  tenantId: null,
  accessMode: 'allow_all',
  allowAllSessions: true,
  sessionSlugGlobs: ['shop-*'],
  authorizedPrincipals: [],
  dashboardConfirm: true,
  requireNoEvaluate: false,
  redactUsername: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe('VaultBindingRepository', () => {
  it('upserts with optimistic versions', async () => {
    const created = await t.repos.vaultBindings.upsert(binding, 0);
    expect(created).toEqual(binding);
    let error: unknown;
    try {
      await t.repos.vaultBindings.upsert(binding, 0);
    } catch (e) {
      error = e;
    }
    expect(isAppError(error, 'CONFLICT')).toBe(true);
    if (isAppError(error, 'CONFLICT')) expect(error.details).toEqual({ current_version: 1 });
    const updated = await t.repos.vaultBindings.upsert(
      { ...binding, title: 'GH', updatedAt: 2 },
      1,
    );
    expect(updated).toMatchObject({ title: 'GH', version: 2, createdAt: 1, updatedAt: 2 });
    try {
      await t.repos.vaultBindings.upsert({ ...binding, title: 'stale' }, 1);
    } catch (e) {
      error = e;
    }
    expect(isAppError(error, 'CONFLICT')).toBe(true);
    const forced = await t.repos.vaultBindings.upsert({
      ...binding,
      title: 'forced',
      updatedAt: 3,
    });
    expect(forced.version).toBe(3);
    expect(await t.repos.vaultBindings.count()).toBe(1);
    expect(await t.repos.vaultBindings.remove('github')).toBe(true);
    expect(await t.repos.vaultBindings.remove('github')).toBe(false);
  });

  it('lists with group filter, search and cursor', async () => {
    await t.repos.vaultBindings.upsert(binding);
    await t.repos.vaultBindings.upsert({ ...binding, handle: 'aws', title: 'AWS', groupId: null });
    await t.repos.vaultBindings.upsert({ ...binding, handle: 'zulip', title: 'Zulip' });
    const page = await t.repos.vaultBindings.list({ limit: 2 });
    expect(page.items.map((b) => b.handle)).toEqual(['aws', 'github']);
    expect(
      (await t.repos.vaultBindings.list({ limit: 2, cursor: page.nextCursor })).items.map(
        (b) => b.handle,
      ),
    ).toEqual(['zulip']);
    expect(
      (await t.repos.vaultBindings.list({ groupId: null })).items.map((b) => b.handle),
    ).toEqual(['aws']);
    expect((await t.repos.vaultBindings.list({ groupId: 'g1' })).items.length).toBe(2);
    expect((await t.repos.vaultBindings.list({ q: 'zul' })).items.length).toBe(1);
  });

  it('exports and imports (merge and replace)', async () => {
    await t.repos.vaultBindings.upsert(binding);
    await t.repos.vaultGroupPolicies.upsert(policy);
    const doc = await t.repos.vaultBindings.exportAll();
    expect(doc).toEqual({ version: 3, bindings: [binding], policies: [policy] });
    await t.repos.vaultBindings.upsert({ ...binding, handle: 'extra' });
    expect(await t.repos.vaultBindings.importAll(doc, 'merge')).toEqual({
      bindings: 1,
      policies: 1,
    });
    expect(await t.repos.vaultBindings.count()).toBe(2);
    expect((await t.repos.vaultBindings.get('github'))?.version).toBe(2);
    expect(await t.repos.vaultBindings.importAll(doc, 'replace')).toEqual({
      bindings: 1,
      policies: 1,
    });
    expect(await t.repos.vaultBindings.count()).toBe(1);
    expect((await t.repos.vaultBindings.get('github'))?.version).toBe(1);
    await t.uow.transaction(async (r) => {
      await r.vaultBindings.importAll(
        { version: 3, bindings: [{ ...binding, handle: 'in-tx' }], policies: [] },
        'merge',
      );
    });
    expect(await t.repos.vaultBindings.count()).toBe(2);
  });
});

describe('VaultGroupPolicyRepository', () => {
  it('round-trips and versions', async () => {
    expect(await t.repos.vaultGroupPolicies.upsert(policy)).toEqual(policy);
    expect(
      await t.repos.vaultGroupPolicies.upsert({ ...policy, accessMode: 'manual' }, 1),
    ).toMatchObject({ accessMode: 'manual', version: 2 });
    let error: unknown;
    try {
      await t.repos.vaultGroupPolicies.upsert(policy, 1);
    } catch (e) {
      error = e;
    }
    expect(isAppError(error, 'CONFLICT')).toBe(true);
    expect((await t.repos.vaultGroupPolicies.list()).length).toBe(1);
    expect(await t.repos.vaultGroupPolicies.count()).toBe(1);
    expect(await t.repos.vaultGroupPolicies.remove('g1')).toBe(true);
    expect(await t.repos.vaultGroupPolicies.get('g1')).toBeNull();
  });
});
