/** @module app/templates/template-operations-deadline.test — the overall deadline of a restore or seed (review #79 L-3, D25) on a fake clock: the operation fails, the browser is stopped without a checkpoint, the hold is released and a late apply writes nothing; and the `afterApply` hook (probes, D22) after a success only. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { FakeTemplateStateStore } from '../../../test/helpers/fake-state-store.ts';
import { FakeTemplateHost, fakeCookie } from '../../../test/helpers/fake-template-host.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingDegradations } from '../../../test/helpers/template-kit.ts';
import {
  TEMPLATE_ID,
  templateRecord,
  templateSiteRecord,
} from '../../../test/persistence/helpers.ts';
import type { TemplateState } from '../../ports/template-state.ts';
import {
  OPERATION_TIMEOUT_CODE,
  TEMPLATE_OPERATION_DEADLINE_MS,
  TemplateOperations,
  type TemplateOperationsDeps,
} from './template-operations.ts';
import { TemplateStateService } from './template-state.ts';

const DEADLINE_MS = 60_000;
const STATE = {
  cookies: [
    {
      name: 'sid',
      value: 'seeded-value-000000',
      domain: '.site-a.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [],
};

let repos: InMemoryRepositories & { operatorActions: InMemoryOperatorActionRepository };
let ops: FakeTemplateHostOps;
let host: FakeTemplateHost;
let clock: FakeClock;
let state: TemplateStateService;
let applied: { templateId: string; kind: string }[];
let changed: string[];
let logger: CollectingLogger;

async function setup(
  extra: Partial<TemplateOperationsDeps> = {},
  status: 'ready' | 'recording' = 'ready',
): Promise<TemplateOperations> {
  repos = Object.assign(new InMemoryRepositories(), {
    operatorActions: new InMemoryOperatorActionRepository(),
  });
  await repos.templates.insert(templateRecord({ status }));
  await repos.templateSites.upsert(templateSiteRecord());
  ops = new FakeTemplateHostOps();
  host = new FakeTemplateHost(TEMPLATE_ID);
  host.cookies = [fakeCookie('.site-a.test', 'sid', 'original-value-000000')];
  ops.host = host;
  clock = new FakeClock();
  logger = new CollectingLogger();
  state = new TemplateStateService({
    repos,
    store: new FakeTemplateStateStore(),
    hostOf: () => host,
    clock,
    logger,
    degradations: new RecordingDegradations(),
    config: { checkpointIntervalMs: 900_000, versionsKeep: 10 },
  });
  applied = [];
  changed = [];
  let n = 0;
  return new TemplateOperations({
    repos,
    ops,
    state,
    ids: { opaque: (size) => String(++n).padStart(size, '0'), eventId: () => `e-${++n}` },
    clock,
    logger,
    deadlineMs: DEADLINE_MS,
    afterApply: (templateId, kind) => void applied.push({ templateId, kind }),
    changed: (id) => void changed.push(id),
    ...extra,
  });
}

/** Lets pending continuations run (the fake clock does not move). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await Bun.sleep(1);
}

/** A `setStorageState` that hangs until the test releases it. */
function hangApply(): () => void {
  let release: () => void = () => undefined;
  const original = host.setStorageState.bind(host);
  host.setStorageState = (next: TemplateState) =>
    new Promise<void>((resolve) => {
      release = () => void original(next).then(resolve);
    });
  return () => release();
}

describe('operation deadline (D25)', () => {
  let operations: TemplateOperations;
  beforeEach(async () => {
    operations = await setup();
  });

  it('defaults to ten minutes', () => {
    expect(TEMPLATE_OPERATION_DEADLINE_MS).toBe(600_000);
  });

  it('a hung restore fails at the deadline: browser stopped, hold released, nothing written', async () => {
    await state.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    const release = hangApply();
    const { operation_id } = await operations.restore(TEMPLATE_ID, 1, {
      forceClose: true,
      by: 'a',
    });
    await flush();
    expect(operations.get(operation_id).state).toBe('running');
    await clock.advance(DEADLINE_MS - 1);
    await flush();
    expect(operations.get(operation_id).state).toBe('running');
    expect(ops.holds.has(TEMPLATE_ID)).toBe(true);

    await clock.advance(1);
    await flush();
    const op = operations.get(operation_id);
    expect(op).toMatchObject({ state: 'failed', error: { code: OPERATION_TIMEOUT_CODE } });
    expect(op.error?.message).toContain('did not finish within 1 min');
    expect(op.finished_at).toBe(clock.now());
    expect(ops.calls).toEqual([`drain:${TEMPLATE_ID}:true`, `discard:${TEMPLATE_ID}`]);
    expect(ops.holds.size).toBe(0);
    expect(changed).toEqual([TEMPLATE_ID]);
    expect(applied).toEqual([]);

    // The hung apply finishes later: no version, the operation stays failed.
    release();
    await flush();
    expect(await repos.templateVersions.get(TEMPLATE_ID, 2)).toBeNull();
    expect(operations.get(operation_id).state).toBe('failed');
    expect(applied).toEqual([]);
  });

  it('a hung seed fails too and leaves a recording template in recording', async () => {
    operations = await setup({}, 'recording');
    const release = hangApply();
    const { operation_id } = await operations.seed(TEMPLATE_ID, STATE, { confirm: false, by: 'a' });
    await flush();
    await clock.advance(DEADLINE_MS);
    await flush();
    expect(operations.get(operation_id)).toMatchObject({
      state: 'failed',
      kind: 'seed',
      error: { code: OPERATION_TIMEOUT_CODE },
    });
    release();
    await flush();
    expect((await repos.templates.get(TEMPLATE_ID))?.status).toBe('recording');
    expect(await repos.templateVersions.get(TEMPLATE_ID, 1)).toBeNull();
  });

  it('a drain that ends after the deadline starts no browser and applies nothing', async () => {
    await state.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    let finishDrain: () => void = () => undefined;
    const drain = ops.drainForOperation.bind(ops);
    ops.drainForOperation = (template, force) =>
      new Promise((resolve) => {
        finishDrain = () => void drain(template, force).then(resolve);
      });
    let started = 0;
    const withHost = ops.withHost.bind(ops);
    ops.withHost = (template, fn) => {
      started += 1;
      return withHost(template, fn);
    };
    const { operation_id } = await operations.restore(TEMPLATE_ID, 1, {
      forceClose: false,
      by: 'a',
    });
    await flush();
    await clock.advance(DEADLINE_MS);
    await flush();
    expect(operations.get(operation_id).state).toBe('failed');
    finishDrain();
    await flush();
    expect(started).toBe(0);
    expect(host.applied).toEqual([]);
    expect(await repos.templateVersions.get(TEMPLATE_ID, 2)).toBeNull();
  });

  it('a failure to stop the browser is logged; the hold is still released', async () => {
    await state.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    hangApply();
    ops.discardHost = async () => {
      throw new Error('close failed');
    };
    const { operation_id } = await operations.restore(TEMPLATE_ID, 1, {
      forceClose: true,
      by: 'a',
    });
    await flush();
    await clock.advance(DEADLINE_MS);
    await flush();
    expect(operations.get(operation_id).state).toBe('failed');
    expect(ops.holds.size).toBe(0);
    expect(logger.records.some((r) => r.msg === 'host discard failed')).toBe(true);
  });

  it('an operation that finishes in time cancels its deadline', async () => {
    const { operation_id } = await operations.seed(TEMPLATE_ID, STATE, { confirm: true, by: 'a' });
    await flush();
    expect(operations.get(operation_id).state).toBe('done');
    expect(clock.pendingSleeps).toBe(0);
    await clock.advance(DEADLINE_MS);
    await flush();
    expect(operations.get(operation_id).state).toBe('done');
    expect(ops.calls).not.toContain(`discard:${TEMPLATE_ID}`);
  });
});

describe('afterApply (D22 hook)', () => {
  it('is called once after a successful restore and seed, never after a failure', async () => {
    const operations = await setup();
    await state.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    const restore = await operations.restore(TEMPLATE_ID, 1, { forceClose: true, by: 'a' });
    await flush();
    expect(operations.get(restore.operation_id).state).toBe('done');
    const seed = await operations.seed(TEMPLATE_ID, STATE, { confirm: true, by: 'a' });
    await flush();
    expect(operations.get(seed.operation_id).state).toBe('done');
    expect(applied).toEqual([
      { templateId: TEMPLATE_ID, kind: 'restore' },
      { templateId: TEMPLATE_ID, kind: 'seed' },
    ]);
    ops.host = null;
    const failed = await operations.restore(TEMPLATE_ID, 1, { forceClose: true, by: 'a' });
    await flush();
    expect(operations.get(failed.operation_id).state).toBe('failed');
    expect(applied).toHaveLength(2);
  });

  it('a hook that throws never fails the operation', async () => {
    const operations = await setup({
      afterApply: () => {
        throw new Error('probe engine down');
      },
    });
    const { operation_id } = await operations.seed(TEMPLATE_ID, STATE, { confirm: true, by: 'a' });
    await flush();
    expect(operations.get(operation_id).state).toBe('done');
    expect(ops.holds.size).toBe(0);
    expect(logger.records.some((r) => r.msg === 'after-apply hook failed')).toBe(true);
  });
});
