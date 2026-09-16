/** @module features/vault/bindings/binding-form.test — handle grammar (contracts `VAULT_HANDLE_RE`), required item, origin grammar, derived handles, PUT body mapping */
import { describe, expect, it } from 'bun:test';
import { VAULT_HANDLE_RE } from '@browserhive/contracts/http';
import {
  bindingFormSchema,
  deriveHandle,
  EMPTY_BINDING_FORM,
  parseLines,
  toPutBody,
} from './binding-form.ts';

const valid = {
  ...EMPTY_BINDING_FORM,
  handle: 'work.github',
  item_name: 'GitHub Login',
  allowed_origins: 'github.com\n*.github.com',
};

function errorPaths(values: typeof valid): string[] {
  const result = bindingFormSchema.safeParse(values);
  return result.success ? [] : result.error.issues.map((i) => String(i.path[0]));
}

describe('binding form', () => {
  it('enforces the contracts handle grammar', () => {
    expect(errorPaths(valid)).toEqual([]);
    for (const bad of ['', 'Work/GitHub', '-leading', 'has space', 'UPPER', 'x'.repeat(129)]) {
      expect(errorPaths({ ...valid, handle: bad })).toContain('handle');
    }
    for (const good of ['a', 'work.github', 'no_folder-item.2'])
      expect(errorPaths({ ...valid, handle: good })).toEqual([]);
  });

  it('requires an item name and valid origins', () => {
    expect(errorPaths({ ...valid, item_name: '  ' })).toContain('item_name');
    expect(errorPaths({ ...valid, allowed_origins: 'https://github.com/login' })).toContain(
      'allowed_origins',
    );
    expect(errorPaths({ ...valid, allowed_origins: 'localhost:8080, *.corp.example' })).toEqual([]);
  });

  it('derives handles that always satisfy VAULT_HANDLE_RE', () => {
    expect(deriveHandle('Work', 'GitHub Login')).toBe('work.github-login');
    expect(deriveHandle(null, '  Bank / Main ')).toBe('bank-main');
    for (const [g, n] of [
      ['Ünïcode Grp', 'Item #1'],
      [null, '...x'],
      ['A', 'B'],
    ] as const) {
      expect(VAULT_HANDLE_RE.test(deriveHandle(g, n))).toBe(true);
    }
  });

  it('maps form values to the PUT body', () => {
    expect(parseLines(' a \n\n b, c ')).toEqual(['a', 'b', 'c']);
    expect(
      toPutBody({
        ...valid,
        authorized_session_slugs: 'agent-*',
        allow_all_sessions: true,
        dashboard_confirm: true,
      }),
    ).toEqual({
      title: 'GitHub Login',
      item_name: 'GitHub Login',
      group_id: null,
      allowed_origins: ['github.com', '*.github.com'],
      authorized_session_slugs: [],
      authorized_principals: [],
      allow_all_sessions: true,
      redact_username: false,
      require_no_evaluate: false,
      dashboard_confirm: true,
    });
  });
});
