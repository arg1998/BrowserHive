/** @module app/templates/template-operations.test — restore and seed as operations (spec 13 §3.12, §7.4): synchronous refusals, the hold, closing or waiting for sessions, the state applied in memory, the version written, the template made ready, and failures reported on the operation. */

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
import { isAppError } from '../../kernel/errors/app-error.ts';
import { TemplateOperations } from './template-operations.ts';
import { TemplateStateService } from './template-state.ts';

let repos: InMemoryRepositories & { operatorActions: InMemoryOperatorActionRepository };
let ops: FakeTemplateHostOps;
let host: FakeTemplateHost;
let state: TemplateStateService;
let operations: TemplateOperations;
let events: { name: string; payload: unknown }[];

async function setup(status: 'ready' | 'recording' | 'disabled' = 'ready'): Promise<void> {
  repos = Object.assign(new InMemoryRepositories(), {
    operatorActions: new InMemoryOperatorActionRepository(),
  });
  await repos.templates.insert(templateRecord({ status }));
  await repos.templateSites.upsert(templateSiteRecord());
  ops = new FakeTemplateHostOps();
  host = new FakeTemplateHost(TEMPLATE_ID);
  host.cookies = [fakeCookie('.site-a.test', 'sid', 'original-value-000000')];
  ops.host = host;
  const clock = new FakeClock();
  events = [];
  const bus = { publish: (name: string, payload: unknown) => void events.push({ name, payload }) };
  state = new TemplateStateService({
    repos,
    store: new FakeTemplateStateStore(),
    hostOf: () => host,
    clock,
    logger: new CollectingLogger(),
    degradations: new RecordingDegradations(),
    bus,
    config: { checkpointIntervalMs: 900_000, versionsKeep: 10 },
  });
  let n = 0;
  operations = new TemplateOperations({
    repos,
    ops,
    state,
    ids: { opaque: (size) => String(++n).padStart(size, '0'), eventId: () => `e-${++n}` },
    clock,
    logger: new CollectingLogger(),
    bus,
  });
}

/** Waits until the operation is no longer running. */
async function settled(id: string) {
  for (let i = 0; i < 100; i++) {
    const op = operations.get(id);
    if (op.state !== 'running') return op;
    await Bun.sleep(1);
  }
  throw new Error('operation still running');
}

async function code(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return isAppError(err) ? err.code : String(err);
}

beforeEach(() => setup());

describe('restore (spec 13 §3.12)', () => {
  it('closes sessions as chosen, applies the version in memory and writes a restore version', async () => {
    await state.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'admin' });
    host.cookies = [fakeCookie('.site-a.test', 'sid', 'later-value-0000000')];
    ops.liveSessions = ['agent-aaaaaaaa'];
    const { operation_id } = await operations.restore(TEMPLATE_ID, 1, {
      forceClose: true,
      by: 'admin',
    });
    const op = await settled(operation_id);
    expect(op).toMatchObject({
      state: 'done',
      kind: 'restore',
      version: 2,
      closed_sessions: ['agent-aaaaaaaa'],
    });
    expect(ops.calls).toEqual([`drain:${TEMPLATE_ID}:true`]);
    expect(host.applied[0]?.cookies[0]?.value).toBe('original-value-000000');
    const v2 = await repos.templateVersions.get(TEMPLATE_ID, 2);
    expect(v2).toMatchObject({ reason: 'restore', restoredFrom: 1 });
    expect(ops.holds.size).toBe(0);
    expect(repos.operatorActions.rows.map((r) => r.action)).toEqual(['template.version.restore']);
    expect(events.filter((e) => e.name === 'template.operation')).toHaveLength(2);
  });

  it('waits for sessions without force_close, and restores the checkpoint (latest → restored_from 0)', async () => {
    await state.checkpoint(TEMPLATE_ID);
    const { operation_id } = await operations.restore(TEMPLATE_ID, 'latest', {
      forceClose: false,
      by: 'a',
    });
    expect((await settled(operation_id)).state).toBe('done');
    expect(ops.calls).toEqual([`drain:${TEMPLATE_ID}:false`]);
    expect((await repos.templateVersions.get(TEMPLATE_ID, 1))?.restoredFrom).toBe(0);
  });

  it('refuses unknown and unreadable versions synchronously, and a second operation', async () => {
    expect(await code(operations.restore(TEMPLATE_ID, 9, { forceClose: true, by: 'a' }))).toBe(
      'TEMPLATE_VERSION_NOT_FOUND',
    );
    await state.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    ops.holds.add(TEMPLATE_ID);
    expect(await code(operations.restore(TEMPLATE_ID, 1, { forceClose: true, by: 'a' }))).toBe(
      'CONFLICT',
    );
  });

  it('reports a failure on the operation and releases the hold', async () => {
    await state.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    ops.host = null;
    const { operation_id } = await operations.restore(TEMPLATE_ID, 1, {
      forceClose: true,
      by: 'a',
    });
    const op = await settled(operation_id);
    expect(op.state).toBe('failed');
    expect(op.error?.code).toBe('INTERNAL_ERROR');
    expect(ops.holds.size).toBe(0);
  });
});

describe('seed (spec 13 §7.4)', () => {
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
    origins: [{ origin: 'https://site-a.test', localStorage: [{ name: 'auth', value: 'x' }] }],
  };

  it('seeds a recording template: applies the state, writes an import version, sets ready', async () => {
    await setup('recording');
    const { operation_id } = await operations.seed(TEMPLATE_ID, STATE, { confirm: false, by: 'a' });
    const op = await settled(operation_id);
    expect(op).toMatchObject({ state: 'done', kind: 'seed', version: 1 });
    expect(host.applied[0]?.cookies[0]?.value).toBe('seeded-value-000000');
    expect((await repos.templateVersions.get(TEMPLATE_ID, 1))?.reason).toBe('import');
    expect((await repos.templates.get(TEMPLATE_ID))?.status).toBe('ready');
  });

  it('needs confirm over a ready template and refuses a disabled one', async () => {
    expect(await code(operations.seed(TEMPLATE_ID, STATE, { confirm: false, by: 'a' }))).toBe(
      'CONFLICT',
    );
    const ok = await operations.seed(TEMPLATE_ID, STATE, { confirm: true, by: 'a' });
    expect((await settled(ok.operation_id)).state).toBe('done');
    await setup('disabled');
    expect(await code(operations.seed(TEMPLATE_ID, STATE, { confirm: true, by: 'a' }))).toBe(
      'TEMPLATE_DISABLED',
    );
  });

  it('answers NOT_FOUND for an unknown operation', () => {
    expect(() => operations.get('op-000000000000')).toThrow();
  });
});
