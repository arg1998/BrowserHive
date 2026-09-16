/** @module features/vault/transfer/import-diff — pure diff of an export document against the current bindings/policies for the import preview (merge vs replace) */
import type { VaultExportDocument } from '@browserhive/contracts/http';
import { VaultExportDocument as VaultExportDocumentSchema } from '@browserhive/contracts/http';

/** Change kind for one row. */
export type DiffKind = 'add' | 'change' | 'remove' | 'same';

/** One diff line. */
export interface DiffEntry {
  readonly kind: DiffKind;
  readonly key: string;
  /** Field names that differ (`change` only). */
  readonly fields: readonly string[];
}

/** Diff of one import. */
export interface ImportDiff {
  readonly bindings: readonly DiffEntry[];
  readonly policies: readonly DiffEntry[];
  readonly counts: { readonly [K in DiffKind]: number };
}

const IGNORED: ReadonlySet<string> = new Set(['created_at', 'updated_at', 'version']);

function changedFields(current: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const names = new Set([...Object.keys(current), ...Object.keys(next)]);
  return [...names]
    .filter((name) => !IGNORED.has(name))
    .filter((name) => JSON.stringify(current[name] ?? null) !== JSON.stringify(next[name] ?? null))
    .sort();
}

function diffRows<C extends object, N extends object>(
  current: readonly C[],
  next: readonly N[],
  keyOf: (row: C | N) => string,
  mode: 'merge' | 'replace',
): DiffEntry[] {
  const byKey = new Map(current.map((row) => [keyOf(row), row]));
  const out: DiffEntry[] = [];
  const seen = new Set<string>();
  for (const row of next) {
    const key = keyOf(row);
    seen.add(key);
    const existing = byKey.get(key);
    if (existing === undefined) {
      out.push({ kind: 'add', key, fields: [] });
      continue;
    }
    const fields = changedFields(
      existing as Record<string, unknown>,
      row as Record<string, unknown>,
    );
    out.push({ kind: fields.length > 0 ? 'change' : 'same', key, fields });
  }
  if (mode === 'replace') {
    for (const [key] of byKey) if (!seen.has(key)) out.push({ kind: 'remove', key, fields: [] });
  }
  const order: Record<DiffKind, number> = { remove: 0, change: 1, add: 2, same: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.key.localeCompare(b.key));
}

/** Key of a group policy (`null` group = ungrouped). */
export function policyKey(row: { readonly group_id: string | null }): string {
  return row.group_id ?? '(ungrouped)';
}

/** Diff an import document against the current export (`GET /vault/export`). `replace` also lists rows that would be removed. */
export function diffImport(
  current: Pick<VaultExportDocument, 'bindings' | 'policies'>,
  document: VaultExportDocument,
  mode: 'merge' | 'replace',
): ImportDiff {
  const bindings = diffRows(current.bindings, document.bindings, (row) => row.handle, mode);
  const policies = diffRows(current.policies, document.policies, policyKey, mode);
  const counts = { add: 0, change: 0, remove: 0, same: 0 };
  for (const entry of [...bindings, ...policies]) counts[entry.kind] += 1;
  return { bindings, policies, counts };
}

/** Parse an uploaded file's text: JSON syntax then the contracts document schema. */
export function parseImportText(
  text: string,
):
  | { readonly ok: true; readonly document: VaultExportDocument }
  | { readonly ok: false; readonly error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  const parsed = VaultExportDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0 ? 'document' : issue.path.join('.');
    return {
      ok: false,
      error: `Not a vault export (version 3): ${where} — ${issue?.message ?? 'invalid'}.`,
    };
  }
  return { ok: true, document: parsed.data };
}
