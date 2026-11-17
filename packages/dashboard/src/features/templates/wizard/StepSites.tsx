/** @module features/templates/wizard/StepSites — step 2 (spec 13 §7.1, §9.6): the site catalog of known sites (pack cards from `GET /site-packs`), **Add another site** by domain (`www.` and paths are dropped; the server keeps the registrable domain), and the chosen sites as cards. A site whose domain has a pack says which version adding it approves (provenance and SHA-256), and the create request carries that `pack_sha256`; any other site is a generic site whose sign-in BrowserHive learns when you press I'm signed in */
import type { SitePackView } from '@browserhive/contracts/http';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useSitePackCatalog } from '@/features/site-packs/api.ts';
import { approvalSentence, packChoice, packForHost } from '@/features/site-packs/model.ts';
import { ICONS } from '@/lib/icons.ts';
import { Field } from '../fields.tsx';
import { hostOf } from '../model.ts';
import { addSite, removeSite, SITES_MAX, type TemplateDraft } from './draft.ts';
import { SiteCatalog } from './SiteCatalog.tsx';

/** The pack and the sentence to show for a host, when a pack with a version on offer owns it. */
export function packNote(
  packs: readonly SitePackView[],
  host: string | null,
): { readonly pack: SitePackView; readonly sha256: string; readonly text: string } | null {
  if (host === null) return null;
  const pack = packForHost(packs, host);
  const choice = pack === null ? null : packChoice(pack);
  if (pack === null || choice === null) return null;
  return { pack, sha256: choice.sha256, text: approvalSentence(pack, choice) };
}

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
  const Globe = ICONS.globe;
  const Package = ICONS.sitePacks;
  const Plus = ICONS.plus;
  const X = ICONS.close;
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
          label={packs.length > 0 ? 'Add another site' : 'Add a site'}
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
            {draft.sites.map((site) => {
              const sha = draft.packs[site];
              const note = sha === undefined ? null : packNote(packs, site);
              const Icon = sha === undefined ? Globe : Package;
              return (
                <li
                  key={site}
                  className="flex min-w-0 items-start gap-3 rounded-lg border bg-surface-inset p-3"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon aria-hidden="true" className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-base">
                      {note !== null ? `${note.pack.title} · ${site}` : site}
                    </span>
                    <span className="text-sm text-pretty text-muted-foreground [overflow-wrap:anywhere]">
                      {sha === undefined
                        ? 'BrowserHive learns its sign-in when you confirm it'
                        : (note?.text ?? `Adds its site pack (SHA-256 ${sha.slice(0, 12)}…)`)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${site}`}
                    onClick={() => onDraft((d) => removeSite(d, site))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
