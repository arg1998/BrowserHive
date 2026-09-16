/** @module features/overview/live-hold.test — frozen order maths for held live lists (new rows held, updated rows keep their slot, removed rows leave) and the pill wording */

import { describe, expect, it } from 'bun:test';
import { newRowsLabel } from './components/NewRowsPill.tsx';
import { applyFrozenOrder, freezeOrder } from './live-hold.ts';

interface Row {
  readonly id: string;
  readonly v: number;
}
const id = (r: Row) => r.id;
const version = (r: Row) => r.v;

describe('applyFrozenOrder', () => {
  const frozen = freezeOrder<Row>(
    [
      { id: 'b', v: 2 },
      { id: 'a', v: 1 },
    ],
    id,
    version,
  );

  it('shows live rows untouched when nothing is frozen', () => {
    const rows = [{ id: 'c', v: 3 }];
    expect(applyFrozenOrder(rows, null, id, version)).toEqual({
      shown: rows,
      pending: 0,
      added: 0,
    });
  });

  it('holds new rows back and keeps the frozen order', () => {
    const live = [
      { id: 'c', v: 3 },
      { id: 'b', v: 2 },
      { id: 'a', v: 1 },
    ];
    const held = applyFrozenOrder(live, frozen, id, version);
    expect(held.shown.map(id)).toEqual(['b', 'a']);
    expect(held).toMatchObject({ pending: 1, added: 1 });
  });

  it('keeps an updated row in its slot with fresh contents and counts it as pending', () => {
    const live = [
      { id: 'a', v: 9 },
      { id: 'b', v: 2 },
    ];
    const held = applyFrozenOrder(live, frozen, id, version);
    expect(held.shown).toEqual([
      { id: 'b', v: 2 },
      { id: 'a', v: 9 },
    ]);
    expect(held).toMatchObject({ pending: 1, added: 0 });
  });

  it('drops rows that left the list (a dismissal is the reader’s own action)', () => {
    const held = applyFrozenOrder([{ id: 'a', v: 1 }], frozen, id, version);
    expect(held.shown.map(id)).toEqual(['a']);
    expect(held.pending).toBe(0);
  });
});

describe('newRowsLabel', () => {
  it('words new rows, updates and both', () => {
    expect(newRowsLabel(1, 1, 'navigation')).toBe('1 new navigation');
    expect(newRowsLabel(3, 3, 'notification')).toBe('3 new notifications');
    expect(newRowsLabel(1, 0, 'notification')).toBe('1 update');
    expect(newRowsLabel(4, 2, 'notification')).toBe('2 new, 2 updates');
  });
});
