/** @module infra/site-packs/guard-hits-writer.test — a guard decision becomes one `site_pack.guard_hit` row with its pack, guard, kind and template; a `warn` hit of a session records `SITE_GUARD_WARNED`; a failing bus never throws. */

import { describe, expect, it } from 'bun:test';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import type { SessionWarning } from '../../domain/session/warnings.ts';
import type { RequestGuardHit } from '../../ports/request-guard.ts';
import type { SiteGuardEvents } from '../../ports/site-guards.ts';
import { SiteGuardHitsWriter } from './guard-hits-writer.ts';
import { GuardRuleCatalog } from './guard-rules.ts';

const hit = (over: Partial<RequestGuardHit> = {}): RequestGuardHit => ({
  sessionId: 'demo-00000001',
  ruleId: 'browserhive#github-oauth-approve',
  ruleAction: 'block',
  action: 'block',
  outcome: null,
  decidedBy: null,
  requestId: null,
  method: 'POST',
  resourceType: 'document',
  url: 'https://github.com/login/oauth/authorize',
  source: 'request',
  ts: 42,
  ...over,
});

function world() {
  const bus = new RecordingEventBus<SiteGuardEvents>();
  const warnings: SessionWarning[] = [];
  const logger = createCollectingLogger();
  const writer = new SiteGuardHitsWriter({
    describe: new GuardRuleCatalog().describe,
    bus,
    ids: new FakeIdGenerator(),
    warn: (_id, w) => warnings.push(w),
    logger,
  });
  const rows = () =>
    bus.published.map((p) => (p.payload as SiteGuardEvents['site_pack.guard_hit']).row);
  return { bus, writer, warnings, rows, logger };
}

describe('SiteGuardHitsWriter', () => {
  it('maps a network hit to a site_guard_hits row of its template', () => {
    const w = world();
    w.writer.forTemplate('tp-aaaaaaaaaa').record(hit());
    expect(w.bus.names()).toEqual(['site_pack.guard_hit']);
    expect(w.rows()[0]).toMatchObject({
      session_id: 'demo-00000001',
      template_id: 'tp-aaaaaaaaaa',
      pack_id: 'browserhive',
      guard_id: 'github-oauth-approve',
      guard_kind: 'credential',
      action: 'block',
      outcome: null,
      source: 'request',
      method: 'POST',
      url: 'https://github.com/login/oauth/authorize',
      tool: null,
      ts: 42,
    });
    expect(w.warnings).toEqual([]);
  });

  it('keeps a confirmation’s outcome, decider and request; a host-owned hit has no session', () => {
    const w = world();
    w.writer.forTemplate('tp-aaaaaaaaaa').record(
      hit({
        sessionId: null,
        ruleId: 'site-a.test#invite',
        ruleAction: 'confirm',
        action: 'confirm',
        outcome: 'denied',
        decidedBy: 'admin',
        requestId: 'att-1',
      }),
    );
    expect(w.rows()[0]).toMatchObject({
      session_id: null,
      pack_id: 'site-a.test',
      guard_id: 'invite',
      guard_kind: 'write',
      action: 'confirm',
      outcome: 'denied',
      decided_by: 'admin',
      request_id: 'att-1',
    });
  });

  it('a warn hit of a session records SITE_GUARD_WARNED on it', () => {
    const w = world();
    w.writer.forTemplate('tp-aaaaaaaaaa').record(hit({ ruleAction: 'warn', action: 'warn' }));
    w.writer
      .forTemplate('tp-aaaaaaaaaa')
      .record(hit({ ruleAction: 'warn', action: 'warn', sessionId: null }));
    expect(w.warnings).toHaveLength(1);
    expect(w.warnings[0]).toMatchObject({
      code: 'SITE_GUARD_WARNED',
      sessionId: 'demo-00000001',
      details: { pack_id: 'browserhive', guard_id: 'github-oauth-approve' },
    });
  });

  it('never throws when the bus does', () => {
    const w = world();
    const broken = new SiteGuardHitsWriter({
      describe: () => null,
      bus: {
        publish: () => {
          throw new Error('down');
        },
      },
      ids: new FakeIdGenerator(),
      warn: () => undefined,
      logger: w.logger,
    });
    expect(() => broken.forTemplate('tp-aaaaaaaaaa').record(hit())).not.toThrow();
    expect(w.logger.records.some((r) => r.msg === 'guard hit not written')).toBe(true);
  });
});

describe('SiteGuardHitsWriter throttle (review PR #83 L3)', () => {
  it('writes one row per identical hit per second, logs what it left out, never drops a decision', () => {
    const w = world();
    const sink = w.writer.forTemplate('tp-aaaaaaaaaa');
    for (let i = 0; i < 50; i += 1) sink.record(hit({ ts: 1_000 + i }));
    sink.record(hit({ ts: 1_100, method: 'GET' }));
    expect(w.rows()).toHaveLength(2);
    sink.record(hit({ ts: 2_100 }));
    expect(w.rows()).toHaveLength(3);
    expect(w.logger.records.find((r) => r.msg === 'guard hits coalesced')?.all).toMatchObject({
      dropped: 49,
    });
    for (let i = 0; i < 3; i += 1) {
      sink.record(hit({ ts: 3_000, ruleAction: 'confirm', action: 'confirm', outcome: 'denied' }));
    }
    expect(w.rows()).toHaveLength(6);
  });
});
