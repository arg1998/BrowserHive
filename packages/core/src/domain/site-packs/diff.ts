/** @module domain/site-packs/diff — the field-level difference between two pack versions (spec 13 §10.6 "exact field-level diff"): lists of objects with an `id` are matched by id (`guards[logout].action`), other lists by position; T3a leaves every field unclassified (T3b adds `classifyPackChange`). */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import type { SitePackChangeFieldRecord } from '../../ports/persistence/site-packs.ts';

/** Fields that never count as a change (bookkeeping of the version itself). */
const IGNORED: ReadonlySet<string> = new Set(['version']);

/** The changed fields, in document order; `from` and `to` are JSON values (`undefined` = absent). */
export function diffPacks(
  from: SitePackV1 | null,
  to: SitePackV1,
): readonly SitePackChangeFieldRecord[] {
  const out: SitePackChangeFieldRecord[] = [];
  walk('', from ?? {}, to, out, true);
  return out;
}

/** Domains `to` adds to `from` (all of them for a new pack). */
export function newDomains(from: SitePackV1 | null, to: SitePackV1): readonly string[] {
  const before = new Set(from?.domains ?? []);
  return to.domains.filter((d) => !before.has(d));
}

function walk(
  path: string,
  a: unknown,
  b: unknown,
  out: SitePackChangeFieldRecord[],
  top = false,
): void {
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      if (top && IGNORED.has(key)) continue;
      walk(path === '' ? key : `${path}.${key}`, a[key], b[key], out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (keyedById(a) && keyedById(b)) {
      const left = new Map(a.map((x) => [idOf(x), x]));
      const right = new Map(b.map((x) => [idOf(x), x]));
      for (const id of new Set([...left.keys(), ...right.keys()])) {
        walk(`${path}[${id}]`, left.get(id), right.get(id), out);
      }
      return;
    }
    if (a.every(isScalar) && b.every(isScalar)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(change(path, a, b));
      return;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(`${path}[${i}]`, a[i], b[i], out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(change(path, a, b));
}

function change(path: string, from: unknown, to: unknown): SitePackChangeFieldRecord {
  return { path, from: from ?? null, to: to ?? null, class: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function keyedById(list: readonly unknown[]): boolean {
  return list.every((x) => isRecord(x) && typeof x['id'] === 'string');
}

function idOf(value: unknown): string {
  return isRecord(value) && typeof value['id'] === 'string' ? value['id'] : '';
}
