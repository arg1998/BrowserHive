/** @module infra/browsers/page-attribution.test — the decision order of spec 13 §3.4 (claim, opener, hold, fallback), claims that never override, tombstones and their bound. */

import { describe, expect, it } from 'bun:test';
import { PARKED, PageAttribution, sameOwner, sessionOwner } from './page-attribution.ts';

const A = sessionOwner('a');
const B = sessionOwner('b');

function host(): PageAttribution {
  return new PageAttribution({ fallback: PARKED });
}

describe('PageAttribution.decide', () => {
  it('a claim wins over the opener', () => {
    const state = host();
    state.commit('opener', B);
    state.claim('t1', A);
    expect(state.decide({ targetId: 't1', openerId: 'opener' }, { final: false })).toEqual({
      kind: 'attributed',
      owner: A,
      rule: 'claim',
    });
  });

  it("an opened page goes to its opener's owner, a parked opener's child is parked", () => {
    const state = host();
    state.commit('a-page', A);
    state.commit('parked-page', PARKED);
    expect(state.decide({ targetId: 'p1', openerId: 'a-page' }, { final: false })).toEqual({
      kind: 'attributed',
      owner: A,
      rule: 'opener',
    });
    expect(state.decide({ targetId: 'p2', openerId: 'parked-page' }, { final: false })).toEqual({
      kind: 'attributed',
      owner: PARKED,
      rule: 'opener',
    });
  });

  it('an opener that closed first still decides (tombstone)', () => {
    const state = host();
    state.commit('oauth', A);
    state.close('oauth');
    expect(state.ownerOf('oauth')).toEqual(A);
    const decision = state.decide({ targetId: 'p', openerId: 'oauth' }, { final: false });
    expect(decision).toEqual({ kind: 'attributed', owner: A, rule: 'opener' });
  });

  it('holds an unknown page while a createTarget is pending, parks it once final', () => {
    const state = host();
    state.beginCreate();
    expect(state.creating).toBe(true);
    const facts = { targetId: 'x', openerId: null };
    expect(state.decide(facts, { final: false })).toEqual({ kind: 'held' });
    expect(state.decide(facts, { final: true })).toEqual({
      kind: 'attributed',
      owner: PARKED,
      rule: 'fallback',
    });
    state.endCreate();
    expect(state.decide(facts, { final: false }).kind).toBe('attributed');
  });

  it('holds a page whose opener is held or may still be read, never when final', () => {
    const state = host();
    state.hold('opener');
    const child = { targetId: 'child', openerId: 'opener' };
    expect(state.decide(child, { final: false })).toEqual({ kind: 'held' });
    expect(state.decide(child, { final: true }).kind).toBe('attributed');
    const orphan = { targetId: 'orphan', openerId: 'unknown' };
    expect(state.decide(orphan, { final: false }).kind).toBe('attributed');
    expect(state.decide(orphan, { final: false, openerPending: true })).toEqual({ kind: 'held' });
  });

  it('an exclusive host falls back to its one session', () => {
    const state = new PageAttribution({ fallback: A });
    expect(state.decide({ targetId: 'ctrl-t', openerId: null }, { final: false })).toEqual({
      kind: 'attributed',
      owner: A,
      rule: 'fallback',
    });
  });
});

describe('PageAttribution state', () => {
  it('an attribution never changes: a later claim for another owner is refused', () => {
    const state = host();
    expect(state.commit('t', PARKED)).toEqual(PARKED);
    expect(state.claim('t', A)).toBe(false);
    expect(state.claim('t', PARKED)).toBe(true);
    expect(state.commit('t', A)).toEqual(PARKED);
    state.close('t');
    expect(state.claim('t', A)).toBe(false);
    expect(state.ownerOf('t')).toEqual(PARKED);
  });

  it('commit consumes the claim; close drops a claim nobody adopted', () => {
    const state = host();
    state.claim('t', A);
    state.commit('t', A);
    state.claim('u', B);
    state.close('u');
    expect(state.decide({ targetId: 'u', openerId: null }, { final: false })).toEqual({
      kind: 'attributed',
      owner: PARKED,
      rule: 'fallback',
    });
    expect(state.ownerOf('u')).toBeUndefined();
  });

  it("releaseSession drops the session's pending claims and keeps its tombstones", () => {
    const state = host();
    state.claim('pending', A);
    state.claim('other', B);
    state.commit('done', A);
    state.close('done');
    state.releaseSession('a');
    expect(state.decide({ targetId: 'pending', openerId: null }, { final: false })).toEqual({
      kind: 'attributed',
      owner: PARKED,
      rule: 'fallback',
    });
    expect(state.decide({ targetId: 'other', openerId: null }, { final: false }).kind).toBe(
      'attributed',
    );
    expect(state.ownerOf('done')).toEqual(A);
  });

  it('keeps only the newest tombstones', () => {
    const state = new PageAttribution({ fallback: PARKED, tombstoneLimit: 2 });
    for (const id of ['t1', 't2', 't3']) {
      state.commit(id, A);
      state.close(id);
    }
    expect(state.ownerOf('t1')).toBeUndefined();
    expect(state.ownerOf('t2')).toEqual(A);
    expect(state.ownerOf('t3')).toEqual(A);
  });

  it('sameOwner compares sessions by id and parked with parked', () => {
    expect(sameOwner(A, sessionOwner('a'))).toBe(true);
    expect(sameOwner(A, B)).toBe(false);
    expect(sameOwner(PARKED, PARKED)).toBe(true);
    expect(sameOwner(PARKED, A)).toBe(false);
  });
});
