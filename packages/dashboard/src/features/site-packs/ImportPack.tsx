/** @module features/site-packs/ImportPack — **Import…** (spec 13 §10.5, `POST /site-packs/import`, ≤ 1 MiB): one unsigned pack file sent as its exact `{text}` (it waits for approval like any local file, a toast says so), or a signed folder (a folder picker, or several files including `keys.json`) sent as `{files, name}` and verified with the pinned keys exactly as a fetch; the page shows what a signed folder became (the index accepted, each version's state) and why an import was refused, every `SITE_PACK_INVALID` issue listed by field. The pickers live once per page (`useImportPicker`); the header and the Registry card share them through `ImportMenu` */
import {
  SITE_PACK_IMPORT_MAX_BYTES,
  type SitePackImportResponse,
} from '@browserhive/contracts/http';
import { type ReactNode, useRef } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useImportSitePack } from './api.ts';
import { isLayout, layoutBody, pickedFile } from './import-layout.ts';
import {
  IMPORT_STATE_TEXT,
  importCounts,
  importLayoutTitle,
  importStateTone,
} from './registry-model.ts';

/** A refused import: a title and the field issues, if any. */
export interface ImportProblem {
  readonly kind: 'problem';
  readonly title: string;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/** A signed folder's import as accepted. */
export interface ImportLayoutResult {
  readonly kind: 'layout';
  readonly name: string;
  readonly response: SitePackImportResponse;
}

/** What the page shows after an import. */
export type ImportOutcome = ImportProblem | ImportLayoutResult;

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

function problem(title: string, issues: ImportProblem['issues'] = []): ImportProblem {
  return { kind: 'problem', title, issues };
}

/** The page's import pickers and what they do. */
export interface ImportPicker {
  /** The hidden inputs; render once. */
  readonly inputs: ReactNode;
  readonly pickFile: () => void;
  readonly pickFolder: () => void;
  readonly pending: boolean;
}

/** The pickers; an outcome (a refusal, a signed folder's result) goes to `onOutcome`. */
export function useImportPicker(onOutcome: (outcome: ImportOutcome | null) => void): ImportPicker {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const mutation = useImportSitePack();
  const toast = useToast();

  const refused = (error: unknown, what: string) => {
    const e = toAppError(error);
    onOutcome(
      e.code === 'SITE_PACK_INVALID'
        ? problem(`${what} isn’t a valid site pack`, importIssues(e.details))
        : problem(e.message),
    );
  };

  const importOne = async (file: File) => {
    if (file.size > SITE_PACK_IMPORT_MAX_BYTES) {
      onOutcome(problem(`${file.name} is larger than 1 MiB`));
      return;
    }
    // The file's exact text: the server hashes and stores these bytes, so the SHA-256 it asks you
    // to approve is the one `sitepacks verify` prints for the file (review S-M3, S-L2).
    const text = await file.text();
    if (text.trim() === '') {
      onOutcome(problem(`${file.name} is empty`));
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
      refused(error, file.name);
    }
  };

  const importLayout = async (files: readonly File[]) => {
    const body = await layoutBody(files.map(pickedFile));
    if (!body.ok) {
      onOutcome(problem('This folder can’t be imported', [{ path: '', message: body.problem }]));
      return;
    }
    try {
      const response = await mutation.mutateAsync({ files: body.files, name: body.name });
      onOutcome({ kind: 'layout', name: body.name, response });
    } catch (error) {
      refused(error, body.name);
    }
  };

  const onPicked = async (list: FileList | null, input: HTMLInputElement) => {
    const files = list === null ? [] : Array.from(list);
    input.value = '';
    const first = files[0];
    if (first === undefined) return;
    onOutcome(null);
    if (files.length === 1 && !isLayout(files.map(pickedFile))) await importOne(first);
    else await importLayout(files);
  };

  const inputs = (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="application/json,.json,.sig"
        className="sr-only"
        tabIndex={-1}
        aria-label="Site pack file"
        onChange={(event) => void onPicked(event.target.files, event.currentTarget)}
      />
      <input
        ref={(el) => {
          folderInput.current = el;
          // React has no prop for the folder picker: set the attribute browsers read.
          el?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Signed site pack folder"
        onChange={(event) => void onPicked(event.target.files, event.currentTarget)}
      />
    </>
  );
  return {
    inputs,
    pickFile: () => fileInput.current?.click(),
    pickFolder: () => folderInput.current?.click(),
    pending: mutation.isPending,
  };
}

/** The Import… menu: a pack file, or a signed folder. */
export function ImportMenu({
  picker,
  size = 'default',
}: {
  readonly picker: ImportPicker;
  readonly size?: 'default' | 'sm';
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="outline" size={size} disabled={picker.pending} />}
      >
        {picker.pending ? <Spinner /> : <ICONS.seed aria-hidden="true" />}
        Import…
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onClick={picker.pickFile} className="items-start">
          <ICONS.seed aria-hidden="true" className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            <span>Pack file…</span>
            <span className="text-xs text-muted-foreground">
              One JSON file; it waits for your approval.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={picker.pickFolder} className="items-start">
          <ICONS.folder aria-hidden="true" className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            <span>Signed folder…</span>
            <span className="text-xs text-muted-foreground">
              An export from another BrowserHive, verified with the registry keys.
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What a signed folder's import became, version by version. */
function LayoutResult({
  result,
  onDismiss,
}: {
  readonly result: ImportLayoutResult;
  readonly onDismiss: () => void;
}) {
  const { response } = result;
  const refused = response.imported.some((i) => i.state === 'refused');
  return (
    <Callout
      tone={refused ? 'warn' : 'success'}
      title={importLayoutTitle(response, result.name)}
      action={
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <p>
          {response.layout !== undefined
            ? `Signed by ${response.layout.signed_by}, keys version ${response.layout.keys_version}. `
            : ''}
          {importCounts(response)}
        </p>
        {response.imported.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {response.imported.map((i) => (
              <li
                key={`${i.pack_id}:${i.version}:${i.sha256}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1"
              >
                <bdi className="font-medium">{i.pack_id}</bdi>
                <span className="tabular-nums">v{i.version}</span>
                <Chip tone={importStateTone(i.state)}>{IMPORT_STATE_TEXT[i.state] ?? i.state}</Chip>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Callout>
  );
}

/** Why an import was refused, field by field. */
function ProblemResult({
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
              {issue.path !== '' ? (
                <>
                  <bdi className="font-mono text-xs">{issue.path}</bdi>:{' '}
                </>
              ) : null}
              <bdi>{issue.message}</bdi>
            </li>
          ))}
        </ul>
      ) : (
        'Choose a site pack JSON file of at most 1 MiB, or a signed folder.'
      )}
    </Callout>
  );
}

/** The outcome of the last import. */
export function ImportOutcomeCallout({
  outcome,
  onDismiss,
}: {
  readonly outcome: ImportOutcome;
  readonly onDismiss: () => void;
}) {
  return outcome.kind === 'layout' ? (
    <LayoutResult result={outcome} onDismiss={onDismiss} />
  ) : (
    <ProblemResult problem={outcome} onDismiss={onDismiss} />
  );
}
