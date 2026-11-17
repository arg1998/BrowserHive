/** @module app/site-packs/security-intercepts.test — the security-intercept state machine over the real broker and a fake clock: held writes (approve, deny, timeout, abort, close), one write per session, ten intercepts per template, host-owned and stdio refusals, the one-time passes, site checks with their bounds and health, and the tool hold. */

import { describe, expect, it } from 'bun:test';
import {
  TEMPLATE,
  TIMEOUT,
  interceptsWorld as world,
} from '../../../test/helpers/intercepts-world.ts';
import type { ChallengeInput, WriteApprovalInput } from '../../ports/security-intercepts.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { MAX_OPEN_INTERCEPTS_PER_TEMPLATE } from './security-intercepts-state.ts';

const confirmer = (w: ReturnType<typeof world>) => {
  const c = w.intercepts.confirmer;
  if (c === null) throw new Error('no confirmer');
  return c;
};

const approval = (
  sessionId: string,
  over: Partial<WriteApprovalInput> = {},
): WriteApprovalInput => ({
  sessionId,
  templateId: TEMPLATE.templateId,
  site: 'site-a.test',
  packId: 'site-a.test',
  guardId: 'invite-button',
  guardKind: 'write',
  method: null,
  url: 'https://www.site-a.test/in/someone',
  tool: 'click',
  source: 'element',
  ...over,
});

const challenge = (sessionId: string, over: Partial<ChallengeInput> = {}): ChallengeInput => ({
  sessionId,
  templateId: TEMPLATE.templateId,
  site: 'site-a.test',
  siteTitle: 'Site A',
  packId: 'site-a.test',
  challenge: { id: 'checkpoint', kind: 'checkpoint', action: 'attention' },
  pageUrl: 'https://www.site-a.test/checkpoint/challenge',
  ...over,
});

describe('SecurityInterceptService — the network confirmer', () => {
  it('holds a write as a security_intercept until approved; the session is held meanwhile', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    const answer = confirmer(w).confirm(w.write(s));
    await w.flush();
    const open = w.broker.listOpen('security_intercept');
    expect(open).toHaveLength(1);
    const row = open[0];
    if (row === undefined) throw new Error('no row');
    expect(row).toMatchObject({
      kind: 'security_intercept',
      sessionId: s,
      owner: 'agent-1',
      templateId: TEMPLATE.templateId,
      deadlineAt: 1_000_000 + TIMEOUT,
      options: {
        reason: 'write_confirm',
        site: 'site-a.test',
        guard: { id: 'invite', kind: 'write' },
        method: 'POST',
        url: 'https://www.site-a.test/api/invite',
        source: 'request',
      },
    });
    expect(w.intercepts.holdOf(s)).toEqual({
      requestId: row.requestId,
      site: 'site-a.test',
      reason: 'write_confirm',
    });
    expect(w.warnings.map((x) => x.code)).toEqual(['SITE_WRITE_HELD']);
    await w.broker.resolve(row.requestId, { status: 'resolved' }, 'admin');
    expect(await answer).toEqual({
      outcome: 'approved',
      decidedBy: 'admin',
      requestId: row.requestId,
    });
    expect(w.intercepts.holdOf(s)).toBeNull();
  });

  it('a deny aborts; the deadline is max(attentionTimeout, minAttentionWait) and times out', async () => {
    const w = world({ minWait: 120_000 });
    const s = w.add('demo-00000001');
    const denied = confirmer(w).confirm(w.write(s));
    await w.flush();
    const first = w.broker.listOpen()[0];
    expect(first?.deadlineAt).toBe(1_000_000 + 120_000);
    await w.broker.resolve(first?.requestId ?? '', { status: 'rejected' }, 'admin');
    expect((await denied).outcome).toBe('denied');

    const timed = confirmer(w).confirm(w.write(s));
    await w.flush();
    await w.clock.advance(120_000);
    expect((await timed).outcome).toBe('timeout');
    expect(w.intercepts.holdOf(s)).toBeNull();
  });

  it('the held request going away cancels it; closing the session cancels it', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    const abort = new AbortController();
    const gone = confirmer(w).confirm(w.write(s, { signal: abort.signal }));
    await w.flush();
    abort.abort();
    expect((await gone).outcome).toBe('cancelled');
    expect(w.broker.listOpen()).toHaveLength(0);

    const closed = confirmer(w).confirm(w.write(s));
    await w.flush();
    w.bus.publish('session.closed', {
      type: 'session.closed',
      session_id: s,
      reason: 'user',
    } as unknown as DomainEvents['session.closed']);
    expect((await closed).outcome).toBe('cancelled');
    expect(w.intercepts.holdOf(s)).toBeNull();
  });

  it('a rejection nobody made (the broker settling a closing session) reads as cancelled', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    const answer = confirmer(w).confirm(w.write(s));
    await w.flush();
    await w.broker.settleForSession(s, 'user');
    expect((await answer).outcome).toBe('cancelled');
  });

  it('a second write of a held session is aborted and names the held request', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    void confirmer(w).confirm(w.write(s));
    await w.flush();
    const held = w.intercepts.holdOf(s)?.requestId;
    const second = await confirmer(w).confirm(w.write(s, { url: 'https://www.site-a.test/x' }));
    expect(second).toEqual({ outcome: 'cancelled', decidedBy: null, requestId: held ?? null });
    expect(w.broker.listOpen()).toHaveLength(1);
  });

  it('a host-owned request and a session that is gone are refused as a block (D-67)', async () => {
    const w = world();
    expect(await confirmer(w).confirm(w.write(null))).toMatchObject({ asBlock: true });
    expect(await confirmer(w).confirm(w.write('gone-00000001'))).toMatchObject({ asBlock: true });
    expect(w.broker.listOpen()).toHaveLength(0);
  });

  it('beyond ten open intercepts per template a write is refused and its session held on the newest', async () => {
    const w = world();
    for (let i = 0; i < MAX_OPEN_INTERCEPTS_PER_TEMPLATE; i += 1) {
      const s = w.add(`demo-0000000${i}`);
      void confirmer(w).confirm(w.write(s));
      await w.flush();
      await w.clock.advance(1);
    }
    const newest = w.broker.listOpen().at(-1)?.requestId;
    const extra = w.add('more-00000001');
    expect(await confirmer(w).confirm(w.write(extra))).toMatchObject({ asBlock: true });
    expect(w.intercepts.holdOf(extra)?.requestId).toBe(newest);
    expect(w.broker.listOpen()).toHaveLength(MAX_OPEN_INTERCEPTS_PER_TEMPLATE);
  });

  it('publishes site_pack.confirm with the open count of the template site', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    void confirmer(w).confirm(w.write(s));
    await w.flush();
    const id = w.intercepts.holdOf(s)?.requestId ?? '';
    await w.broker.resolve(id, { status: 'rejected' }, 'admin');
    await w.flush();
    const events = w.bus.published
      .filter((p) => p.name === 'site_pack.confirm')
      .map((p) => p.payload as DomainEvents['site_pack.confirm']);
    expect(events.map((e) => [e.phase, e.open, e.status])).toEqual([
      ['opened', 1, undefined],
      ['settled', 0, 'rejected'],
    ]);
    expect(events[0]).toMatchObject({
      template_name: 'Job Hunt',
      site_title: 'Site A',
      guard: { pack_id: 'site-a.test', id: 'invite', kind: 'write' },
    });
  });
});

describe('SecurityInterceptService — the tool path and its passes', () => {
  it('opens a request without waiting; an approval grants one pass, which also covers the write it sends', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    const first = await w.intercepts.requestWriteApproval(approval(s));
    if (first.kind !== 'pending') throw new Error(first.kind);
    expect(await w.intercepts.requestWriteApproval(approval(s))).toEqual(first);
    expect(w.intercepts.holdOf(s)?.requestId).toBe(first.requestId);
    await w.broker.resolve(first.requestId, { status: 'resolved' }, 'admin');
    await w.flush();
    expect(w.hits).toEqual([
      expect.objectContaining({
        action: 'confirm',
        outcome: 'approved',
        decidedBy: 'admin',
        source: 'element',
        tool: 'click',
        requestId: first.requestId,
        guardId: 'invite-button',
      }),
    ]);
    expect(await w.intercepts.requestWriteApproval(approval(s))).toEqual({ kind: 'pass' });
    // The click's own write passes the network guard once, without a second request.
    expect(await confirmer(w).confirm(w.write(s))).toEqual({
      outcome: 'approved',
      decidedBy: 'admin',
      requestId: first.requestId,
    });
    expect(w.broker.listOpen()).toHaveLength(0);
    // One-time: the next one asks again.
    const again = await w.intercepts.requestWriteApproval(approval(s));
    expect(again.kind).toBe('pending');
  });

  it('a pass expires after 10 minutes', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    const first = await w.intercepts.requestWriteApproval(approval(s));
    if (first.kind !== 'pending') throw new Error(first.kind);
    await w.broker.resolve(first.requestId, { status: 'resolved' }, 'admin');
    await w.flush();
    await w.clock.advance(10 * 60_000);
    expect((await w.intercepts.requestWriteApproval(approval(s))).kind).toBe('pending');
  });

  it('a network approval grants no pass: an identical later write is asked again', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    const answer = confirmer(w).confirm(w.write(s));
    await w.flush();
    await w.broker.resolve(w.intercepts.holdOf(s)?.requestId ?? '', { status: 'resolved' }, 'a');
    expect((await answer).outcome).toBe('approved');
    void confirmer(w).confirm(w.write(s));
    await w.flush();
    expect(w.broker.listOpen()).toHaveLength(1);
  });
});

describe('SecurityInterceptService — transport=stdio', () => {
  it('has no confirmer, refuses write approvals and only marks health for a challenge', async () => {
    const w = world({ transport: 'stdio' });
    const s = w.add('demo-00000001');
    expect(w.intercepts.confirmer).toBeNull();
    expect(await w.intercepts.requestWriteApproval(approval(s))).toEqual({
      kind: 'blocked',
      reason: 'no_operator',
    });
    expect(await w.intercepts.raiseChallenge(challenge(s))).toBeNull();
    expect(w.health.map((h) => h.verdict.outcome)).toEqual(['challenged']);
    expect(w.broker.listOpen()).toHaveLength(0);
  });
});

describe('SecurityInterceptService — site checks', () => {
  it('opens a takeover intercept, marks the site challenged, holds the session; resolving probes the site', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    const id = await w.intercepts.raiseChallenge(challenge(s));
    const row = w.broker.listOpen()[0];
    expect(row).toMatchObject({
      requestId: id,
      kind: 'security_intercept',
      mode: 'takeover',
      reason: 'Site A security check',
      options: { reason: 'challenge', challenge: { id: 'checkpoint' }, source: 'page' },
    });
    expect(w.health).toEqual([
      {
        site: 'site-a.test',
        verdict: {
          outcome: 'challenged',
          reason: 'challenge:checkpoint',
          finalUrl: 'https://www.site-a.test/checkpoint/challenge',
        },
      },
    ]);
    expect(w.intercepts.holdOf(s)).toEqual({
      requestId: id ?? '',
      site: 'site-a.test',
      reason: 'challenge',
    });
    // A further match attaches to the open one.
    expect(await w.intercepts.raiseChallenge(challenge(s))).toBe(id);
    await w.broker.resolve(id ?? '', { status: 'resolved' }, 'admin');
    await w.flush();
    expect(w.probes).toEqual(['site-a.test']);
    expect(w.intercepts.holdOf(s)).toBeNull();
  });

  it('opens at most one new check per session per 5 minutes', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    const id = await w.intercepts.raiseChallenge(challenge(s));
    await w.broker.resolve(id ?? '', { status: 'rejected' }, 'admin');
    await w.flush();
    expect(await w.intercepts.raiseChallenge(challenge(s))).toBeNull();
    await w.clock.advance(5 * 60_000);
    expect(await w.intercepts.raiseChallenge(challenge(s))).not.toBeNull();
  });

  it('stop sets the site’s stopped_at', async () => {
    const w = world();
    const s = w.add('demo-00000001');
    await w.intercepts.raiseChallenge(
      challenge(s, { challenge: { id: 'locked', kind: 'locked', action: 'stop' } }),
    );
    expect(w.sites[0]?.stoppedAt).toBe(1_000_000);
  });
});
