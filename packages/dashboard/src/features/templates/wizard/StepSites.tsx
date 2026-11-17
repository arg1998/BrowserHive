/** @module features/templates/wizard/StepSites — step 2 (spec 13 §7.1, §9.6): the site catalog of known sites (pack cards from `GET /site-packs`), **Add a site** by domain (`www.` and paths are dropped; the server keeps the registrable domain), and the chosen sites as cards. A site whose domain has a pack says which version adding it approves (provenance and SHA-256), and the create request carries that `pack_sha256`; any other site is a generic site whose sign-in BrowserHive learns when you press I'm signed in */
import type { SitePackView } from '@browserhive/contracts/http';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useSitePackCatalog } from '@/features/site-packs/api.ts';
import { packChoice, packNote } from '@/features/site-packs/model.ts';
import { ICONS } from '@/lib/icons.ts';
import { Field } from '../fields.tsx';
import { hostOf } from '../model.ts';
import { ChosenSite } from './ChosenSite.tsx';
import { addSite, removeSite, SITES_MAX, type TemplateDraft } from './draft.ts';
import { SiteCatalog } from './SiteCatalog.tsx';

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
  const catalog = useSitePackCatalog();
  const packs = catalog.data?.status.enabled === true ? catalog.data.data : [];
  const typed = packNote(packs, hostOf(text));
  const Plus = ICONS.plus;
  const add = (input: string, sha?: string) => {
    const result = addSite(draft, input, sha);
    setError(result.error);
    if (result.error === null) onDraft(() => result.draft);
    return result.error === null;
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (add(text, typed?.sha256)) setText('');
  };
  const addPack = (pack: SitePackView) => {
    const choice = packChoice(pack);
    if (choice !== null) add(pack.pack_id, choice.sha256);
  };
  const siteErrors = Object.entries(errors).filter(([field]) => field.startsWith('sites'));
  const full = draft.sites.length >= SITES_MAX;
  return (
    <div className="flex flex-col gap-6">
      {packs.length > 0 ? (
        <SiteCatalog packs={packs} chosen={draft.sites} full={full} onAdd={addPack} />
      ) : null}
      <form onSubmit={submit} className="max-w-xl">
        <Field
          label="Add a site"
          htmlFor={inputId}
          help={
            typed?.text ??
            'Any domain the account signs in to. A full address works too: only the domain is kept.'
          }
          error={error ?? siteErrors[0]?.[1]}
        >
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              value={text}
              placeholder="example.com"
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
              <ChosenSite
                key={site}
                site={site}
                sha256={draft.packs[site]}
                packs={packs}
                onRemove={() => onDraft((d) => removeSite(d, site))}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
