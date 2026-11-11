/** @module features/templates/wizard/StepSites — step 2 (spec 13 §7.1): add the sites the account signs in to by domain (`www.` and paths are dropped; the server keeps the registrable domain) and see them as cards. Without site packs every site is a generic site: BrowserHive learns its sign-in when you press I'm signed in */
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { ICONS } from '@/lib/icons.ts';
import { Field } from '../fields.tsx';
import { addSite, SITES_MAX, type TemplateDraft } from './draft.ts';

/** Step 2. */
export function StepSites({
  draft,
  onDraft,
  errors,
}: {
  readonly draft: TemplateDraft;
  readonly onDraft: (update: (d: TemplateDraft) => TemplateDraft) => void;
  readonly errors: Readonly<Record<string, string>>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const Globe = ICONS.globe;
  const Plus = ICONS.plus;
  const X = ICONS.close;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = addSite(draft, text);
    setError(result.error);
    if (result.error === null) {
      onDraft(() => result.draft);
      setText('');
    }
  };
  const siteErrors = Object.entries(errors).filter(([field]) => field.startsWith('sites'));
  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} className="max-w-xl">
        <Field
          label="Add a site"
          htmlFor={inputId}
          help="Any domain the account signs in to. A full address works too: only the domain is kept."
          error={error ?? siteErrors[0]?.[1]}
        >
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              value={text}
              placeholder="linkedin.com"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              inputMode="url"
              className="font-mono"
              aria-invalid={error !== null ? true : undefined}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
            />
            <Button type="submit" variant="outline" disabled={text.trim().length === 0}>
              <Plus aria-hidden="true" />
              Add
            </Button>
          </div>
        </Field>
      </form>
      <section aria-labelledby={`${inputId}-chosen`} className="@container flex flex-col gap-2">
        <h3 id={`${inputId}-chosen`} className="section-label">
          {draft.sites.length === 0
            ? 'No sites yet'
            : `${draft.sites.length} of ${SITES_MAX} sites`}
        </h3>
        {draft.sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add at least one. A template can hold up to {SITES_MAX} sites that share this browser’s
            sign-ins, like a job board and the email account its messages go to.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
            {draft.sites.map((site) => (
              <li
                key={site}
                className="flex min-w-0 items-start gap-3 rounded-lg border bg-surface-inset p-3"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Globe aria-hidden="true" className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-base">{site}</span>
                  <span className="text-sm text-muted-foreground">
                    BrowserHive learns its sign-in when you confirm it
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${site}`}
                  onClick={() =>
                    onDraft((d) => ({ ...d, sites: d.sites.filter((s) => s !== site) }))
                  }
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
