/** @module features/vault/transfer/TransferPanel — export the bindings/policies document as JSON and import one with merge/replace and a diff preview against the current export */
import type { VaultExportDocument } from '@browserhive/contracts/http';
import { useQuery } from '@tanstack/react-query';
import { type ChangeEvent, useId, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useImportVault } from '../api.ts';
import { DiffPreview } from './DiffPreview.tsx';
import { diffImport, parseImportText } from './import-diff.ts';

/** Save a JSON document through a temporary object URL. */
function download(document_: VaultExportDocument, doc: Document = document): void {
  const blob = new Blob([`${JSON.stringify(document_, null, 2)}\n`], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = href;
  anchor.download = 'browserhive-vault.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

/** Transfer panel. */
export function TransferPanel() {
  const api = useApi();
  const toast = useToast();
  const confirm = useConfirm();
  const fileId = useId();
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [file, setFile] = useState<{
    readonly name: string;
    readonly document: VaultExportDocument;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useQuery({
    queryKey: ['vault', 'export'],
    queryFn: () => api.exportVault(),
    enabled: file !== null,
  });
  const importer = useImportVault();
  const onExport = async () => {
    try {
      download(await api.exportVault());
    } catch (raw) {
      toast.fromError(toAppError(raw), 'Export failed');
    }
  };
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    setError(null);
    setFile(null);
    if (picked === undefined) return;
    const parsed = parseImportText(await picked.text());
    if (parsed.ok) setFile({ name: picked.name, document: parsed.document });
    else setError(parsed.error);
  };
  const diff =
    file !== null && current.data !== undefined
      ? diffImport(current.data, file.document, mode)
      : null;
  const onImport = async () => {
    if (file === null) return;
    if (mode === 'replace') {
      const ok = await confirm({
        title: 'Replace every binding and policy?',
        description: `Rows not in ${file.name} are deleted${diff !== null ? ` (${diff.counts.remove} rows)` : ''}.`,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return;
    }
    importer.mutate({ mode, document: file.document }, { onSuccess: () => setFile(null) });
  };
  const Upload = ICONS.download;
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <Panel
        title="Export"
        description="Bindings and group policies as a version 3 JSON document. Policy only, never secrets."
      >
        <Button type="button" variant="outline" onClick={() => void onExport()}>
          <Upload aria-hidden="true" />
          Download JSON
        </Button>
      </Panel>
      <Panel title="Import" description="Load an export document, preview the changes, then apply.">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium" id={`${fileId}-label`}>
              Export document
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor={fileId}
                className={buttonVariants({ variant: 'outline', className: 'cursor-pointer' })}
              >
                Choose file…
              </label>
              <input
                id={fileId}
                type="file"
                accept="application/json,.json"
                aria-labelledby={`${fileId}-label`}
                className="sr-only"
                onChange={(e) => void onFile(e)}
              />
              <span className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {file !== null ? file.name : 'No file chosen'}
              </span>
            </div>
          </div>
          <div role="radiogroup" aria-label="Import mode" className="grid gap-2 sm:grid-cols-2">
            {(['merge', 'replace'] as const).map((value) => (
              // biome-ignore lint/a11y/useSemanticElements: a card-style radio; native radios cannot carry the two-line layout
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  'flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3.5 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  mode === value && 'border-accent-border bg-accent-bg hover:bg-accent-bg-hover',
                )}
              >
                <span className="text-base font-medium">
                  {value === 'merge' ? 'Merge' : 'Replace'}
                </span>
                <span className="text-sm text-muted-foreground">
                  {value === 'merge'
                    ? 'Keep rows that are not in the file.'
                    : 'Delete rows that are not in the file.'}
                </span>
              </button>
            ))}
          </div>
          {error !== null ? (
            <Callout tone="danger" title="Cannot import this file">
              {error}
            </Callout>
          ) : null}
          {current.isError ? (
            <Callout tone="danger" title="Could not load the current vault">
              {toAppError(current.error).message}
            </Callout>
          ) : null}
          {diff !== null ? <DiffPreview diff={diff} /> : null}
          <div>
            <Button
              type="button"
              variant={mode === 'replace' ? 'destructive' : 'default'}
              disabled={file === null || diff === null || importer.isPending}
              onClick={() => void onImport()}
            >
              {mode === 'merge' ? 'Import (merge)' : 'Import (replace)'}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
