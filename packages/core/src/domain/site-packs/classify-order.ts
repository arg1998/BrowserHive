/** @module domain/site-packs/classify-order — the comparisons the §9.7 rules share: keyed diff paths, ordered values, numbers where larger or smaller is stricter, and switches where `true` is stricter. */

import type { ChangeClass } from './classify-types.ts';

/** Splits `guards[logout].match.url` into `{id: 'logout', rest: 'match.url'}` (`rest` `''` for the entry). */
export function keyedPath(path: string, list: string): { id: string; rest: string } | null {
  if (!path.startsWith(`${list}[`)) return null;
  const close = path.indexOf(']', list.length + 1);
  if (close < 0) return null;
  const id = path.slice(list.length + 1, close);
  const tail = path.slice(close + 1);
  if (id === '' || (tail !== '' && !tail.startsWith('.'))) return null;
  return { id, rest: tail.slice(1) };
}

/** A move along `order` (a later value is stricter): stricter tightening, laxer loosening. */
export function ordered(order: readonly string[], from: unknown, to: unknown): ChangeClass {
  const a = typeof from === 'string' ? order.indexOf(from) : -1;
  const b = typeof to === 'string' ? order.indexOf(to) : -1;
  if (a < 0 || b < 0) return 'loosening';
  if (b === a) return 'neutral';
  return b > a ? 'tightening' : 'loosening';
}

/** A number where larger is stricter. */
export function raised(from: unknown, to: unknown): ChangeClass {
  if (typeof from !== 'number' || typeof to !== 'number') return 'loosening';
  if (to === from) return 'neutral';
  return to > from ? 'tightening' : 'loosening';
}

/** A boolean where `true` is stricter. */
export function switchedOn(from: unknown, to: unknown): ChangeClass {
  if (typeof from !== 'boolean' || typeof to !== 'boolean') return 'loosening';
  if (from === to) return 'neutral';
  return to ? 'tightening' : 'loosening';
}

/** A cap where smaller is stricter: lowered tightening, lowered to 1 restrictive, raised loosening. */
export function lowered(from: unknown, to: unknown): ChangeClass {
  if (typeof from !== 'number' || typeof to !== 'number') return 'loosening';
  if (to === from) return 'neutral';
  if (to > from) return 'loosening';
  return to <= 1 ? 'restrictive' : 'tightening';
}
