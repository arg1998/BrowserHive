/** @module domain/session/state.test — every legal and illegal transition of the D-21 state machine. */

import { describe, expect, it } from 'bun:test';
import {
  canServeTools,
  isLaunching,
  isLive,
  isOpen,
  isTerminal,
  reserved,
  type SessionEvent,
  type SessionState,
  transition,
} from './state.ts';

const at = 1_000;
const RESERVED: SessionState = reserved(at);
const LAUNCHING: SessionState = { kind: 'launching', phase: 'launch', at };
const LIVE: SessionState = { kind: 'live', at };
const PAUSED: SessionState = { kind: 'paused', reason: 'attention', at };
const DRAINING: SessionState = { kind: 'draining', reason: 'user', at };
const CLOSED: SessionState = { kind: 'closed', reason: 'user', at };
const CRASHED: SessionState = { kind: 'crashed', detail: 'gone', at };
const ALL = [RESERVED, LAUNCHING, LIVE, PAUSED, DRAINING, CLOSED, CRASHED];

const launch: SessionEvent = { type: 'launch', phase: 'prepareProfile', at: 2 };
const launched: SessionEvent = { type: 'launched', at: 2 };
const pause: SessionEvent = { type: 'pause', reason: 'attention', at: 2 };
const resume: SessionEvent = { type: 'resume', at: 2 };
const drain: SessionEvent = { type: 'drain', reason: 'operator', at: 2 };
const closed: SessionEvent = { type: 'closed', at: 2 };
const crash: SessionEvent = { type: 'crash', detail: 'boom', at: 2 };

function expectOk(state: SessionState, event: SessionEvent): SessionState {
  const result = transition(state, event);
  if (!result.ok)
    throw new Error(`expected ok from ${state.kind} on ${event.type}: ${result.error.message}`);
  return result.value;
}

function expectErr(
  state: SessionState,
  event: SessionEvent,
  code: 'SESSION_NOT_LIVE' | 'INTERNAL_ERROR',
): void {
  const result = transition(state, event);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.from).toBe(state.kind);
  expect(result.error.event).toBe(event.type);
  expect(result.error.message).toBe(`cannot apply '${event.type}' in state '${state.kind}'`);
}

describe('transition — legal moves', () => {
  it('reserved → launching (phase) → launching (advance) → live', () => {
    const l1 = expectOk(RESERVED, launch);
    expect(l1).toEqual({ kind: 'launching', phase: 'prepareProfile', at: 2 });
    const l2 = expectOk(l1, { type: 'launch', phase: 'register', at: 3 });
    expect(l2).toEqual({ kind: 'launching', phase: 'register', at: 3 });
    expect(expectOk(l2, launched)).toEqual({ kind: 'live', at: 2 });
  });

  it('live ⇄ paused', () => {
    const p = expectOk(LIVE, pause);
    expect(p).toEqual({ kind: 'paused', reason: 'attention', at: 2 });
    expect(expectOk(p, resume)).toEqual({ kind: 'live', at: 2 });
  });

  it('drain from reserved, launching, live, paused; closed keeps the drain reason', () => {
    for (const s of [RESERVED, LAUNCHING, LIVE, PAUSED]) {
      const d = expectOk(s, drain);
      expect(d).toEqual({ kind: 'draining', reason: 'operator', at: 2 });
      expect(expectOk(d, closed)).toEqual({ kind: 'closed', reason: 'operator', at: 2 });
    }
  });

  it('crashed from live AND from launching (and paused)', () => {
    expect(expectOk(LIVE, crash)).toEqual({ kind: 'crashed', detail: 'boom', at: 2 });
    expect(expectOk(LAUNCHING, crash)).toEqual({ kind: 'crashed', detail: 'boom', at: 2 });
    expect(expectOk(PAUSED, crash)).toEqual({ kind: 'crashed', detail: 'boom', at: 2 });
  });
});

describe('transition — illegal moves', () => {
  it('launch only from reserved/launching (INTERNAL_ERROR elsewhere)', () => {
    for (const s of [LIVE, PAUSED, DRAINING, CLOSED, CRASHED])
      expectErr(s, launch, 'INTERNAL_ERROR');
  });

  it('launched only from launching', () => {
    for (const s of [RESERVED, LIVE, PAUSED, DRAINING, CLOSED, CRASHED])
      expectErr(s, launched, 'INTERNAL_ERROR');
  });

  it('pause only from live (SESSION_NOT_LIVE elsewhere)', () => {
    for (const s of [RESERVED, LAUNCHING, PAUSED, DRAINING, CLOSED, CRASHED])
      expectErr(s, pause, 'SESSION_NOT_LIVE');
  });

  it('resume only from paused; draining never re-enters live', () => {
    for (const s of [RESERVED, LAUNCHING, LIVE, DRAINING, CLOSED, CRASHED])
      expectErr(s, resume, 'SESSION_NOT_LIVE');
    expectErr(DRAINING, launched, 'INTERNAL_ERROR');
    expectErr(DRAINING, launch, 'INTERNAL_ERROR');
  });

  it('drain refused from draining/closed/crashed', () => {
    for (const s of [DRAINING, CLOSED, CRASHED]) expectErr(s, drain, 'SESSION_NOT_LIVE');
  });

  it('closed only from draining', () => {
    for (const s of [RESERVED, LAUNCHING, LIVE, PAUSED, CLOSED, CRASHED])
      expectErr(s, closed, 'INTERNAL_ERROR');
  });

  it('crash refused from reserved/draining/closed/crashed', () => {
    for (const s of [RESERVED, DRAINING, CLOSED, CRASHED]) expectErr(s, crash, 'INTERNAL_ERROR');
  });

  it('terminal states accept nothing', () => {
    for (const s of [CLOSED, CRASHED]) {
      for (const e of [launch, launched, pause, resume, drain, closed, crash]) {
        expect(transition(s, e).ok).toBe(false);
      }
    }
  });
});

describe('predicates', () => {
  it('classify every state', () => {
    expect(ALL.filter(isLive).map((s) => s.kind)).toEqual(['live']);
    expect(ALL.filter(canServeTools).map((s) => s.kind)).toEqual(['live', 'paused']);
    expect(ALL.filter(isTerminal).map((s) => s.kind)).toEqual(['closed', 'crashed']);
    expect(ALL.filter(isOpen).map((s) => s.kind)).toEqual([
      'reserved',
      'launching',
      'live',
      'paused',
      'draining',
    ]);
    expect(ALL.filter(isLaunching).map((s) => s.kind)).toEqual(['reserved', 'launching']);
  });
});
