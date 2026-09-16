/** @module features/vault/transfer/DiffPreview — counts and per-row add/change/remove lines of an import diff */
import { Chip } from '@/components/shared/Chip.tsx';
import type { Tone } from '@/lib/status-registry.ts';
import type { DiffEntry, DiffKind, ImportDiff } from './import-diff.ts';

const KIND: Record<DiffKind, { readonly label: string; readonly tone: Tone }> = {
  add: { label: 'add', tone: 'success' },
  change: { label: 'change', tone: 'warn' },
  remove: { label: 'remove', tone: 'danger' },
  same: { label: 'unchanged', tone: 'muted' },
};

function Rows({
  title,
  entries,
}: {
  readonly title: string;
  readonly entries: readonly DiffEntry[];
}) {
  const visible = entries.filter((e) => e.kind !== 'same');
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">
        {title}{' '}
        <span className="text-muted-foreground">({entries.length - visible.length} unchanged)</span>
      </h3>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {visible.map((entry) => (
            <li
              key={`${entry.kind}:${entry.key}`}
              className="flex flex-wrap items-center gap-2 text-sm [overflow-wrap:anywhere]"
            >
              <Chip tone={KIND[entry.kind].tone}>{KIND[entry.kind].label}</Chip>
              <span className="font-mono">{entry.key}</span>
              {entry.fields.length > 0 ? (
                <span className="text-sm text-muted-foreground">{entry.fields.join(', ')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Diff preview. */
export function DiffPreview({ diff }: { readonly diff: ImportDiff }) {
  return (
    <section
      aria-label="Import preview"
      className="flex flex-col gap-4 rounded-lg bg-muted/60 p-4 dark:bg-white/[0.03]"
    >
      <p className="flex flex-wrap gap-2 text-sm">
        {(['add', 'change', 'remove', 'same'] as const).map((kind) => (
          <Chip key={kind} tone={KIND[kind].tone}>
            {diff.counts[kind]} {KIND[kind].label}
          </Chip>
        ))}
      </p>
      <Rows title="Bindings" entries={diff.bindings} />
      <Rows title="Policies" entries={diff.policies} />
    </section>
  );
}
