/** @module features/site-packs/ImportPack — **Import…** one unsigned pack file (spec 13 §10.5, `POST /site-packs/import` with the file's exact `{text}`, ≤ 1 MiB): the file picker, a toast for what was imported (it waits for approval like any local file), and the callout that says why a file was refused, every `SITE_PACK_INVALID` issue listed by field */
import { SITE_PACK_IMPORT_MAX_BYTES } from '@browserhive/contracts/http';
import { useRef } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useImportSitePack } from './api.ts';

/** A refused import: a title and the field issues, if any. */
export interface ImportProblem {
  readonly title: string;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/** The issues of a `SITE_PACK_INVALID` answer (parsed, never cast). */
export function importIssues(details: Readonly<Record<string, unknown>>): ImportProblem['issues'] {
  const issues = details['issues'];
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const path: unknown = Reflect.get(issue, 'path');
    const message: unknown = Reflect.get(issue, 'message');
    return typeof path === 'string' && typeof message === 'string' ? [{ path, message }] : [];
  });
}

/** The Import… button; a refusal goes to `onProblem` (shown by `ImportProblemCallout`). */
export function ImportButton({
  onProblem,
}: {
  readonly onProblem: (problem: ImportProblem | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mutation = useImportSitePack();
  const toast = useToast();
  const onFile = async (file: File | undefined) => {
    if (input.current !== null) input.current.value = '';
    if (file === undefined) return;
    onProblem(null);
    if (file.size > SITE_PACK_IMPORT_MAX_BYTES) {
      onProblem({ title: `${file.name} is larger than 1 MiB`, issues: [] });
      return;
    }
    // The file's exact text: the server hashes and stores these bytes, so the SHA-256 it asks you
    // to approve is the one `sitepacks verify` prints for the file (review S-M3, S-L2).
    const text = await file.text();
    if (text.trim() === '') {
      onProblem({ title: `${file.name} is empty`, issues: [] });
      return;
    }
    try {
      const result = await mutation.mutateAsync({ text });
      const first = result.imported[0];
      toast.success({
        title:
          first === undefined
            ? 'Nothing was imported'
            : `${first.pack_id} v${first.version} imported`,
        description: 'Review and approve it under Updates available before it applies.',
      });
    } catch (error) {
      const e = toAppError(error);
      onProblem({
        title: e.code === 'SITE_PACK_INVALID' ? `${file.name} isn’t a valid site pack` : e.message,
        issues: e.code === 'SITE_PACK_INVALID' ? importIssues(e.details) : [],
      });
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => input.current?.click()}
      >
        {mutation.isPending ? <Spinner /> : <ICONS.seed aria-hidden="true" />}
        Import…
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-label="Site pack file"
        onChange={(event) => void onFile(event.target.files?.[0])}
      />
    </>
  );
}

/** Why an import was refused, field by field. */
export function ImportProblemCallout({
  problem,
  onDismiss,
}: {
  readonly problem: ImportProblem;
  readonly onDismiss: () => void;
}) {
  return (
    <Callout
      tone="danger"
      title={problem.title}
      action={
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      {problem.issues.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {problem.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`} className="[overflow-wrap:anywhere]">
              <bdi className="font-mono text-xs">{issue.path || '(file)'}</bdi>:{' '}
              <bdi>{issue.message}</bdi>
            </li>
          ))}
        </ul>
      ) : (
        'Choose a site pack JSON file of at most 1 MiB.'
      )}
    </Callout>
  );
}
