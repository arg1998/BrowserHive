/** @module app/site-packs/security-intercepts-races.test — review PR #83 as regression tests: concurrent writes and checks cannot pass the per-session or per-template bounds while the broker's inserts are slow (M3); the template bound counts per session owner (M4, I3); a maintenance session's write is refused like a host-owned one (I4); the passes cover the same tool, control and site only (L6). */

import { describe, expect, it } from 'bun:test';
import { interceptsWorld, TEMPLATE } from '../../../test/helpers/intercepts-world.ts';
import type { ChallengeInput, WriteApprovalInput } from '../../ports/security-intercepts.ts';
import { MAX_OPEN_INTERCEPTS_PER_TEMPLATE } from './security-intercepts-state.ts';

const SLOW = 20;

function confirmerOf(w: ReturnType<typeof interceptsWorld>) {
  const c = w.intercepts.confirmer;
  if (c === null) throw new Error('no confirmer');
  return c;
}

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
  target: '#connect-1',
  ...over,
});

const challenge = (sessionId: string): ChallengeInput => ({
  sessionId,
  templateId: TEMPLATE.templateId,
  site: 'site-a.test',
  siteTitle: 'Site A',
  packId: 'site-a.test',
  challenge: { id: 'checkpoint', kind: 'checkpoint', action: 'attention' },
  pageUrl: 'https://www.site-a.test/checkpoint/challenge',
});

describe('bounds under concurrency with slow storage (M3)', () => {
  it('two concurrent writes of one session open one request; the other is aborted naming it', async () => {
    const w = interceptsWorld({ slowInsertMs: SLOW });
    const s = w.add('demo-00000001');
    const second = Promise.all([
      confirmerOf(w).confirm(w.write(s)),
      confirmerOf(w).confirm(w.write(s, { url: 'https://www.site-a.test/api/invite?n=2' })),
    ]);
    await new Promise((r) => setTimeout(r, SLOW * 3));
    const open = w.broker.listOpen('security_intercept');
    expect(open).toHaveLength(1);
    await w.broker.resolve(open[0]?.requestId ?? '', { status: 'rejected' }, 'admin');
    const [first, other] = await second;
    expect(first.outcome).toBe('denied');
    expect(other).toEqual({ outcome: 'cancelled', decidedBy: null, requestId: open[0]?.requestId ?? '' });
  });

  it('20 concurrent writes on one session never pass the per-session bound', async () => {
    const w = interceptsWorld({ slowInsertMs: SLOW });
    const s = w.add('demo-00000001');
    for (let i = 0; i < 20; i += 1) {
      void confirmerOf(w).confirm(w.write(s, { url: `https://www.site-a.test/api/invite?n=${i}` }));
    }
    await new Promise((r) => setTimeout(r, SLOW * 3));
    expect(w.broker.listOpen()).toHaveLength(1);
  });

  it('25 concurrent writes over 25 sessions of one owner stop at the template bound', async () => {
    const w = interceptsWorld({ slowInsertMs: SLOW });
    const answers = Array.from({ length: 25 }, (_, i) =>
      confirmerOf(w).confirm(w.write(w.add(`demo-${String(i).padStart(8, '0')}`))),
    );
    await new Promise((r) => setTimeout(r, SLOW * 3));
    expect(w.broker.listOpen()).toHaveLength(MAX_OPEN_INTERCEPTS_PER_TEMPLATE);
    const refused = await Promise.race([
      Promise.all(answers.slice(MAX_OPEN_INTERCEPTS_PER_TEMPLATE)),
      new Promise<null>((r) => setTimeout(() => r(null), 100)),
    ]);
    expect(refused?.every((a) => a.asBlock === true)).toBe(true);
  });

  it('a tool-path approval racing a network write of the same session opens one request', async () => {
    const w = interceptsWorld({ slowInsertMs: SLOW });
    const s = w.add('demo-00000001');
    const net = confirmerOf(w).confirm(w.write(s));
    const tool = w.intercepts.requestWriteApproval(approval(s));
    await new Promise((r) => setTimeout(r, SLOW * 3));
    const open = w.broker.listOpen();
    expect(open).toHaveLength(1);
    expect(await tool).toEqual({ kind: 'pending', requestId: open[0]?.requestId ?? '' });
    await w.broker.resolve(open[0]?.requestId ?? '', { status: 'resolved' }, 'admin');
    expect((await net).outcome).toBe('approved');
  });

  it('concurrent site checks of one session open one request and attach the rest', async () => {
    const w = interceptsWorld({ slowInsertMs: SLOW });
    const s = w.add('demo-00000001');
    const ids = await Promise.all([1, 2, 3].map(() => w.intercepts.raiseChallenge(challenge(s))));
    expect(w.broker.listOpen()).toHaveLength(1);
    expect(new Set(ids)).toEqual(new Set([w.broker.listOpen()[0]?.requestId ?? '']));
  });
});

describe('the template bound per session owner (M4, I3)', () => {
  it("one owner's open intercepts do not use up another owner's slots", async () => {
    const w = interceptsWorld();
    for (let i = 0; i < MAX_OPEN_INTERCEPTS_PER_TEMPLATE; i += 1) {
      void confirmerOf(w).confirm(w.write(w.add(`hogs-${String(i).padStart(8, '0')}`)));
      await w.flush();
    }
    const mine = w.add('hogs-99999999');
    expect(await confirmerOf(w).confirm(w.write(mine))).toMatchObject({ asBlock: true });
    // Held on its own owner's newest request, never on another principal's.
    const held = w.intercepts.holdOf(mine)?.requestId;
    const owners = w.broker.listOpen().filter((r) => r.requestId === held);
    expect(owners[0]?.owner).toBe('agent-1');
    const other = w.add('fair-00000001', 'live', 'agent-2');
    void confirmerOf(w).confirm(w.write(other));
    await w.flush();
    expect(w.intercepts.holdOf(other)?.reason).toBe('write_confirm');
    expect(w.broker.listOpen()).toHaveLength(MAX_OPEN_INTERCEPTS_PER_TEMPLATE + 1);
  });
});

describe('maintenance sessions (I4)', () => {
  it('a write of a maintenance session is refused like a host-owned one', async () => {
    const w = interceptsWorld();
    const s = w.add('probe-00000001', 'maintenance');
    expect(await confirmerOf(w).confirm(w.write(s))).toMatchObject({ asBlock: true });
    expect(w.broker.listOpen()).toHaveLength(0);
  });
});

describe('pass width (L6)', () => {
  it('a tool pass covers the same tool and control only; its network pass the same site only', async () => {
    const w = interceptsWorld();
    const s = w.add('demo-00000001');
    const first = await w.intercepts.requestWriteApproval(approval(s));
    if (first.kind !== 'pending') throw new Error(first.kind);
    await w.broker.resolve(first.requestId, { status: 'resolved' }, 'admin');
    await w.flush();
    // Another control of the same guard on the same page is asked again.
    expect(
      (await w.intercepts.requestWriteApproval(approval(s, { target: '#connect-2' }))).kind,
    ).toBe('pending');
    const again = w.intercepts.holdOf(s)?.requestId ?? '';
    await w.broker.resolve(again, { status: 'resolved' }, 'admin');
    await w.flush();
    expect(await w.intercepts.requestWriteApproval(approval(s, { target: '#connect-2' }))).toEqual({
      kind: 'pass',
    });
    // The network pass does not cover a write to another site.
    const elsewhere = confirmerOf(w).confirm(
      w.write(s, { url: 'https://www.site-b.test/api/invite' }),
    );
    await w.flush();
    expect(w.broker.listOpen()).toHaveLength(1);
    await w.broker.resolve(w.broker.listOpen()[0]?.requestId ?? '', { status: 'rejected' }, 'a');
    expect((await elsewhere).outcome).toBe('denied');
    // ...and covers the write to its own site once.
    expect((await confirmerOf(w).confirm(w.write(s))).outcome).toBe('approved');
  });
});
