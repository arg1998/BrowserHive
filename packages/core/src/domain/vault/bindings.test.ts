/** @module domain/vault/bindings.test — handle grammar vs VAULT_HANDLE_RE, origin normalisation, D-14 caller authorization, merge semantics */

import { describe, expect, it } from 'bun:test';
import { VAULT_HANDLE_RE } from '@browserhive/contracts/http';
import {
  deriveHandle,
  handleSegment,
  isCallerAuthorized,
  isValidHandle,
  mergeBinding,
  normalizeOrigin,
  normalizeOrigins,
} from './bindings.ts';

describe('deriveHandle', () => {
  const cases: [string | null, string][] = [
    ['Work', 'GitHub'],
    [null, 'LinkedIn'],
    ['', 'linkedin'],
    ['No Folder', 'Dup'],
    ['Ünïcode Földer!!', '  spaced  name  '],
    ['..dots..', '--dashes--'],
    ['Работа', 'Пароль'],
    ['a'.repeat(200), 'b'.repeat(200)],
    ['', ''],
  ];
  for (const [group, item] of cases) {
    it(`matches VAULT_HANDLE_RE for ${JSON.stringify(group)}/${JSON.stringify(item)}`, () => {
      const handle = deriveHandle(group, item);
      expect(handle).toMatch(VAULT_HANDLE_RE);
      expect(isValidHandle(handle)).toBe(true);
      expect(handle.length).toBeLessThanOrEqual(128);
    });
  }

  it('is deterministic and folds the ungrouped bucket to no-folder', () => {
    expect(deriveHandle('Work', 'GitHub')).toBe('work.github');
    expect(deriveHandle(null, 'LinkedIn')).toBe('no-folder.linkedin');
    expect(deriveHandle('', 'LinkedIn')).toBe(deriveHandle('No Folder', 'LinkedIn'));
    expect(handleSegment('  ')).toBe('item');
  });

  it('rejects handles outside the grammar', () => {
    for (const bad of ['Work/GitHub', '-leading', '', 'UPPER', 'a b', `x${'y'.repeat(200)}`]) {
      expect(isValidHandle(bad)).toBe(false);
    }
  });
});

describe('origins normalisation', () => {
  it('lowercases the host part, keeps the path part verbatim, trims, dedupes, drops empties', () => {
    expect(normalizeOrigin('  LinkedIn.com/Login  ')).toBe('linkedin.com/Login');
    expect(normalizeOrigin('*.GitHub.com')).toBe('*.github.com');
    expect(normalizeOrigins(['A.com', 'a.com', '', '  ', 'B.com/X'])).toEqual(['a.com', 'b.com/X']);
  });
});

describe('caller authorization (D-14)', () => {
  const rule = { allowAllSessions: false, slugGlobs: ['agent-*'], principals: ['p-1'] };

  it('requires BOTH the principal and the slug to match', () => {
    expect(isCallerAuthorized(rule, { principal: 'p-1', slug: 'agent-7' })).toBe(true);
    expect(isCallerAuthorized(rule, { principal: 'p-2', slug: 'agent-7' })).toBe(false);
    expect(isCallerAuthorized(rule, { principal: 'p-1', slug: 'other' })).toBe(false);
  });

  it('an empty principal list admits any principal; allow_all_sessions admits any slug', () => {
    expect(
      isCallerAuthorized({ ...rule, principals: [] }, { principal: 'anyone', slug: 'agent-1' }),
    ).toBe(true);
    expect(
      isCallerAuthorized({ ...rule, allowAllSessions: true }, { principal: 'p-1', slug: 'zzz' }),
    ).toBe(true);
  });

  it('exact slugs match themselves under the glob', () => {
    expect(
      isCallerAuthorized(
        { allowAllSessions: false, slugGlobs: ['exact'], principals: [] },
        {
          principal: 'x',
          slug: 'exact',
        },
      ),
    ).toBe(true);
  });
});

describe('mergeBinding', () => {
  it('requires item_name on create and keeps prior values on update', () => {
    expect(mergeBinding('h', {}, null, 1)).toBeNull();
    const created = mergeBinding('h', { itemName: 'Item', allowedOrigins: ['A.com'] }, null, 1);
    expect(created).toMatchObject({
      handle: 'h',
      title: 'h',
      itemName: 'Item',
      itemId: '',
      groupId: null,
      allowedOrigins: ['a.com'],
      allowAllSessions: false,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const updated = mergeBinding('h', { dashboardConfirm: true }, created, 5);
    expect(updated).toMatchObject({
      itemName: 'Item',
      allowedOrigins: ['a.com'],
      dashboardConfirm: true,
      createdAt: 1,
      updatedAt: 5,
    });
    const grouped = created === null ? null : { ...created, groupId: 'g' };
    expect(mergeBinding('h', { groupId: null }, grouped, 6)?.groupId).toBeNull();
  });
});
