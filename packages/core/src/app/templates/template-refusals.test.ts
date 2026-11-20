/** @module app/templates/template-refusals.test — the agents a template's access rules refused (deferred D60): which refusals count (a ready template refused by its principal or harness list; never a recording or disabled template, an unknown name or an allowed caller), one aggregated row per client and kind, a burst coalesced into one write, the bound per template, and the operator's read. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryWriteQueue } from '../../../test/helpers/in-memory-repos.ts';
import { createTemplateKit, type TemplateKit } from '../../../test/helpers/template-kit.ts';
import {
  TEMPLATE_ID,
  templateRecord,
  templateSiteRecord,
} from '../../../test/persistence/helpers.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { REFUSAL_FLUSH_MS, refusalOf, TemplateRefusals } from './template-refusals.ts';
import type { TemplateCaller } from './template-service.ts';

const LAUNCH = {
  slug: 'jobs',
  channel: 'chromium',
  incognito: false,
  headless: true,
  disableEvaluate: false,
  vaultEnabled: true,
} as const;

function caller(subject: string, harness: string | null, declared?: string): TemplateCaller {
  return {
    principal: { subject },
    client: {
      name: 'c',
      version: null,
      agentName: null,
      model: null,
      harness,
      ...(declared !== undefined && { harnessDeclared: declared }),
    },
  };
}

let clock: FakeClock;
let kit: TemplateKit;

async function seed(overrides: Parameters<typeof templateRecord>[0] = {}): Promise<void> {
  const template = templateRecord(overrides);
  await kit.repos.templates.insert(template);
  await kit.repos.templateSites.upsert(templateSiteRecord({ templateId: template.templateId }));
}

async function rows(templateId = TEMPLATE_ID) {
  return (await kit.refusals.list(templateId)).data;
}

async function launchFails(name: string, who: TemplateCaller): Promise<string> {
  try {
    await kit.service.launch(name, LAUNCH, who);
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('launch succeeded');
}

beforeEach(() => {
  clock = new FakeClock();
  kit = createTemplateKit({ clock, ids: new FakeIdGenerator(), logger: new CollectingLogger() });
});

describe('refusalOf', () => {
  const subject = { principal: 'p-a', harness: null, declared: null };
  it('counts a ready template refused by its principal or harness list', () => {
    const r = refusalOf(templateRecord(), 'harness_not_allowed', subject, 'launch', 7);
    expect(r).toEqual({
      templateId: TEMPLATE_ID,
      principal: 'p-a',
      harness: 'unknown',
      harnessDeclared: null,
      kind: 'launch',
      reason: 'harness_not_allowed',
      count: 1,
      firstAt: 7,
      lastAt: 7,
    });
  });

  it('does not count a recording or disabled template', () => {
    expect(
      refusalOf(templateRecord({ status: 'recording' }), 'recording', subject, 'list', 1),
    ).toBe(null);
    expect(
      refusalOf(
        templateRecord({ status: 'recording' }),
        'principal_not_allowed',
        subject,
        'list',
        1,
      ),
    ).toBe(null);
    expect(
      refusalOf(
        templateRecord({ status: 'disabled' }),
        'principal_not_allowed',
        subject,
        'list',
        1,
      ),
    ).toBe(null);
  });

  it('keeps the declared harness name, bounded', () => {
    const long = 'N'.repeat(300);
    const r = refusalOf(
      templateRecord(),
      'harness_not_allowed',
      { principal: 'p-a', harness: 'other', declared: long },
      'list',
      1,
    );
    expect(r?.harness).toBe('other');
    expect(r?.harnessDeclared).toBe('N'.repeat(128));
  });
});

describe('recording through the template service', () => {
  it('a listing hides a template only because of its access rule: one list row per client', async () => {
    await seed({ authorizedPrincipals: ['p-owner'] });
    await seed({ templateId: 'tp-open000001', name: 'open' });
    await seed({ templateId: 'tp-setup00001', name: 'setup', status: 'recording', harnesses: [] });
    await seed({
      templateId: 'tp-off0000001',
      name: 'off',
      status: 'disabled',
      authorizedPrincipals: ['p-owner'],
    });
    const listed = await kit.service.listForAgent(caller('p-agent', 'cursor'));
    expect(listed.map((t) => t.name)).toEqual(['open']);
    await kit.service.listForAgent(caller('p-agent', 'cursor'));
    await clock.advance(5_000);
    await kit.service.listForAgent(caller('p-agent', 'cursor'));
    expect(await rows()).toEqual([
      {
        principal: 'p-agent',
        harness: 'cursor',
        harness_declared: null,
        kind: 'list',
        reason: 'principal_not_allowed',
        count: 3,
        first_at: clock.now() - 5_000,
        last_at: clock.now(),
      },
    ]);
    expect(await rows('tp-open000001')).toEqual([]);
    expect(await rows('tp-setup00001')).toEqual([]);
    expect(await rows('tp-off0000001')).toEqual([]);
  });

  it('a refused launch is a launch row with the gate reason; an allowed caller adds nothing', async () => {
    await seed({ harnesses: ['claude-code'] });
    expect(await launchFails('job-hunt', caller('p-agent', 'cursor', 'Cursor IDE'))).toBe(
      'TEMPLATE_NOT_FOUND',
    );
    await kit.service.listForAgent(caller('p-agent', 'claude-code'));
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      principal: 'p-agent',
      harness: 'cursor',
      harness_declared: 'Cursor IDE',
      kind: 'launch',
      reason: 'harness_not_allowed',
      count: 1,
    });
  });

  it('an unknown name, a disabled or a recording template records nothing', async () => {
    await seed({ status: 'disabled', authorizedPrincipals: ['p-owner'] });
    await seed({
      templateId: 'tp-setup00001',
      name: 'setup',
      status: 'recording',
      authorizedPrincipals: ['p-owner'],
    });
    expect(await launchFails('nope', caller('p-agent', null))).toBe('TEMPLATE_NOT_FOUND');
    expect(await launchFails('job-hunt', caller('p-agent', null))).toBe('TEMPLATE_NOT_FOUND');
    expect(await launchFails('setup', caller('p-agent', null))).toBe('TEMPLATE_NOT_FOUND');
    await kit.queue.drain();
    expect(kit.queue.operations).toEqual([]);
    expect(kit.repos.templateRefusals.rows.size).toBe(0);
  });

  it('templates=false records nothing', async () => {
    kit = createTemplateKit({
      clock,
      ids: new FakeIdGenerator(),
      logger: new CollectingLogger(),
      config: { enabled: false },
    });
    await seed({ authorizedPrincipals: ['p-owner'] });
    await kit.service.listForAgent(caller('p-agent', null));
    expect(await launchFails('job-hunt', caller('p-agent', null))).toBe('TEMPLATE_NOT_FOUND');
    expect(kit.queue.operations).toEqual([]);
  });

  it('separate rows per principal, harness, declared name and kind', async () => {
    await seed({ authorizedPrincipals: ['p-owner'] });
    await kit.service.listForAgent(caller('p-a', 'cursor'));
    await kit.service.listForAgent(caller('p-b', 'cursor'));
    await kit.service.listForAgent(caller('p-a', 'other', 'Nightly'));
    await kit.service.listForAgent(caller('p-a', 'other', 'Daily'));
    await launchFails('job-hunt', caller('p-a', 'cursor'));
    expect((await rows()).length).toBe(5);
  });
});

describe('TemplateRefusals', () => {
  it('holds a minute of refusals and writes them as one job; the timer, a read or the shutdown flushes (review #93 L1)', async () => {
    const repos = new InMemoryRepositories();
    await repos.templates.insert(templateRecord());
    const queue = new InMemoryWriteQueue(repos);
    const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
    const refusals = new TemplateRefusals({
      queue,
      repos,
      logger: new CollectingLogger(),
      timer: (ms, fn) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
    });
    const one = refusalOf(
      templateRecord(),
      'principal_not_allowed',
      { principal: 'p', harness: 'cursor', declared: null },
      'list',
      10,
    );
    if (one === null) throw new Error('expected a refusal');
    for (let i = 0; i < 50; i++) refusals.note({ ...one, firstAt: 10 + i, lastAt: 10 + i });
    refusals.note({ ...one, reason: 'harness_not_allowed', firstAt: 99, lastAt: 99 });
    refusals.note({ ...one, kind: 'launch', firstAt: 99, lastAt: 99 });
    // Nothing is written per call: one timer holds them all.
    expect(queue.operations).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([REFUSAL_FLUSH_MS]);
    timers[0]?.fn();
    expect(queue.operations).toEqual(['template_refusals.record']);
    const rows = (await refusals.list(TEMPLATE_ID)).data;
    expect(rows.find((r) => r.kind === 'list')).toMatchObject({
      count: 51,
      first_at: 10,
      last_at: 99,
      reason: 'harness_not_allowed',
    });
    expect(queue.operations).toEqual(['template_refusals.record']);
    // The operator's read flushes what is held (and cancels its timer); so does the shutdown.
    refusals.note({ ...one, firstAt: 200, lastAt: 200 });
    const [again] = (await refusals.list(TEMPLATE_ID)).data;
    expect(again).toMatchObject({ kind: 'list', count: 52, first_at: 10, last_at: 200 });
    expect(timers[1]?.cancelled).toBe(true);
    refusals.note({ ...one, firstAt: 300, lastAt: 300 });
    refusals.stop();
    await queue.drain();
    expect(queue.operations).toHaveLength(3);
    expect(timers[2]?.cancelled).toBe(true);
  });

  it('keeps at most maxRows rows per template, dropping the one seen longest ago', async () => {
    const repos = new InMemoryRepositories();
    await repos.templates.insert(templateRecord());
    const queue = new InMemoryWriteQueue(repos);
    const refusals = new TemplateRefusals({
      queue,
      repos,
      logger: new CollectingLogger(),
      maxRows: 3,
    });
    for (let i = 0; i < 5; i++) {
      refusals.note({
        templateId: TEMPLATE_ID,
        principal: `p-${i}`,
        harness: 'cursor',
        harnessDeclared: null,
        kind: 'list',
        reason: 'principal_not_allowed',
        count: 1,
        firstAt: i,
        lastAt: i,
      });
      await queue.drain();
    }
    const page = await refusals.list(TEMPLATE_ID);
    expect(page.max_rows).toBe(3);
    expect(page.data.map((r) => r.principal)).toEqual(['p-4', 'p-3', 'p-2']);
  });

  it('a refused write never throws into the caller, and the list of an unknown template is 404', async () => {
    const repos = new InMemoryRepositories();
    const throwing = {
      enqueue: () => {
        throw new Error('boom');
      },
      drain: async () => undefined,
    };
    const refusals = new TemplateRefusals({
      queue: throwing,
      repos,
      logger: new CollectingLogger(),
    });
    const r = refusalOf(
      templateRecord(),
      'principal_not_allowed',
      { principal: 'p', harness: null, declared: null },
      'launch',
      1,
    );
    if (r === null) throw new Error('expected a refusal');
    expect(() => refusals.note(r)).not.toThrow();
    const error = await refusals.list('tp-missing001').catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('rows go with their template', async () => {
    await seed({ authorizedPrincipals: ['p-owner'] });
    await kit.service.listForAgent(caller('p-agent', null));
    expect((await rows()).length).toBe(1);
    await kit.service.remove(TEMPLATE_ID, { force: true, by: 'local' });
    expect(kit.repos.templateRefusals.rows.size).toBe(1); // cascade is the SQLite FK; reads drop it
    const error = await kit.refusals.list(TEMPLATE_ID).catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe('TEMPLATE_NOT_FOUND');
  });
});
