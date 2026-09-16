/** @module features/vault/transfer/import-diff.test — add/change/same classification, replace-only removals, ignored bookkeeping fields, document parsing errors */
import { describe, expect, it } from 'bun:test';
import type { VaultExportDocument } from '@browserhive/contracts/http';
import { diffImport, parseImportText } from './import-diff.ts';

const binding = (handle: string, extra: Record<string, unknown> = {}) => ({
  handle,
  title: handle,
  item_name: handle,
  item_id: '',
  group_id: null,
  allowed_origins: ['a.example'],
  authorized_principals: [],
  authorized_session_slugs: [],
  allow_all_sessions: false,
  redact_username: false,
  require_no_evaluate: false,
  dashboard_confirm: false,
  ...extra,
});
const policy = (group_id: string | null, access_mode: 'manual' | 'allow_all' | 'reject_all') => ({
  group_id,
  access_mode,
  allow_all_sessions: false,
  session_slug_globs: [],
  authorized_principals: [],
  dashboard_confirm: false,
  require_no_evaluate: false,
  redact_username: false,
});

const current: VaultExportDocument = {
  version: 3,
  bindings: [binding('keep'), binding('edit'), binding('drop')],
  policies: [policy('g1', 'manual'), policy(null, 'allow_all')],
};
const incoming: VaultExportDocument = {
  version: 3,
  bindings: [
    binding('keep'),
    binding('edit', { allowed_origins: ['b.example'], dashboard_confirm: true }),
    binding('new'),
  ],
  policies: [policy('g1', 'reject_all')],
};

describe('diffImport', () => {
  it('classifies rows in merge mode without removals', () => {
    const diff = diffImport(current, incoming, 'merge');
    expect(diff.bindings).toEqual([
      { kind: 'change', key: 'edit', fields: ['allowed_origins', 'dashboard_confirm'] },
      { kind: 'add', key: 'new', fields: [] },
      { kind: 'same', key: 'keep', fields: [] },
    ]);
    expect(diff.policies).toEqual([{ kind: 'change', key: 'g1', fields: ['access_mode'] }]);
    expect(diff.counts).toEqual({ add: 1, change: 2, remove: 0, same: 1 });
  });

  it('lists removals in replace mode and ignores version/timestamps', () => {
    const withMeta = {
      ...current,
      bindings: current.bindings.map((b) => ({ ...b, version: 9, updated_at: 1 })),
    };
    const diff = diffImport(withMeta, incoming, 'replace');
    expect(diff.bindings.filter((e) => e.kind === 'remove').map((e) => e.key)).toEqual(['drop']);
    expect(diff.policies.find((e) => e.kind === 'remove')?.key).toBe('(ungrouped)');
    expect(diff.bindings.find((e) => e.key === 'keep')?.kind).toBe('same');
  });

  it('parses documents and reports the first schema problem', () => {
    expect(parseImportText('{nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    const wrong = parseImportText(JSON.stringify({ version: 2, bindings: [], policies: [] }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('version');
    expect(parseImportText(JSON.stringify(incoming))).toEqual({ ok: true, document: incoming });
  });
});
