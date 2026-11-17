/** @module features/templates/wizard/SiteCatalog — the site catalog of wizard step 2 (spec 13 §7.1, §9.6, §11.4): a searchable grid of pack cards (title, domains, "Sign in by hand only", the default write policy (or that the pack guards no writes yet), what the site's terms say, and the version adding it approves with its provenance and short SHA-256); the whole card is a toggle (`aria-pressed`) that adds the site, or removes it with its pack choice once added (a check that turns into a remove mark on hover and focus) */
import type { SitePackView } from '@browserhive/contracts/http';
import { useId, useState } from 'react';
import { Chip } from '@/components/shared/Chip.tsx';
import { Input } from '@/components/ui/input.tsx';
import {
  NO_WRITE_GUARDS,
  packChoice,
  shortSha,
  WRITE_POLICY_LABEL,
} from '@/features/site-packs/model.ts';
import { StanceLabel } from '@/features/site-packs/PackBits.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** A pack worth a card: one with a version on offer, or a local file waiting for approval (not one that failed validation). */
function listable(pack: SitePackView): boolean {
  return packChoice(pack) !== null || (pack.local !== null && pack.local.problem === null);
}

/** Listable packs whose title, id or domains contain `q`. */
export function filterCatalog(packs: readonly SitePackView[], q: string): readonly SitePackView[] {
  const needle = q.trim().toLowerCase();
  const usable = packs.filter(listable);
  if (needle === '') return usable;
  return usable.filter(
    (p) =>
      p.title.toLowerCase().includes(needle) ||
      p.pack_id.includes(needle) ||
      p.domains.some((d) => d.includes(needle)),
  );
}

/** The chosen sites a pack covers (its domains or their subdomains). */
export function sitesOfPack(pack: SitePackView, chosen: readonly string[]): readonly string[] {
  return chosen.filter((site) => pack.domains.some((d) => site === d || site.endsWith(`.${d}`)));
}

/**
 * One pack card: a toggle button the size of the card. Added: pressed, and pressing it removes the
 * site. Not added: off while no version is on offer, a no-op while the template is full.
 */
function PackCard({
  pack,
  added,
  onToggle,
}: {
  readonly pack: SitePackView;
  readonly added: boolean;
  readonly onToggle: () => void;
}) {
  const choice = packChoice(pack);
  const disabled = !added && choice === null;
  return (
    <li className="min-w-0">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={added}
        aria-label={added ? `Remove ${pack.title}` : `Add ${pack.title}`}
        onClick={onToggle}
        className={cn(
          'group flex h-full w-full min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors focus-ring dark:shadow-none',
          !disabled && 'cursor-pointer',
          !added && !disabled && 'hover:border-ring/50 hover:bg-accent/40 active:bg-accent',
          added &&
            'border-success-border bg-success-bg/40 hover:border-danger-border hover:bg-danger-bg/40 focus-visible:border-danger-border',
          disabled && 'opacity-70',
        )}
      >
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="flex min-w-0 flex-col">
            <bdi className="truncate text-base font-semibold">{pack.title}</bdi>
            <bdi className="truncate font-mono text-sm text-muted-foreground">
              {pack.domains.join(', ')}
            </bdi>
          </span>
          {added ? (
            <span
              aria-hidden="true"
              className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-success-border bg-success-bg ps-2 pe-2.5 text-sm font-medium text-success-text transition-colors group-hover:border-danger-border group-hover:bg-danger-bg group-hover:text-danger-text group-focus-visible:border-danger-border group-focus-visible:bg-danger-bg group-focus-visible:text-danger-text"
            >
              <ICONS.check className="size-4 group-hover:hidden group-focus-visible:hidden" />
              <ICONS.close className="hidden size-4 group-hover:block group-focus-visible:block" />
              <span className="group-hover:hidden group-focus-visible:hidden">Added</span>
              <span className="hidden group-hover:inline group-focus-visible:inline">Remove</span>
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
            >
              <ICONS.plus className="size-4" />
            </span>
          )}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {pack.human_only ? <Chip tone="warn">Sign in by hand only</Chip> : null}
          {pack.write_guards === 0 ? (
            <Chip tone="muted" title={NO_WRITE_GUARDS}>
              Writes not guarded yet
            </Chip>
          ) : (
            <Chip tone="neutral">Writes: {WRITE_POLICY_LABEL[pack.write_policy_default]}</Chip>
          )}
          {!pack.enabled ? <Chip tone="muted">Turned off</Chip> : null}
        </span>
        <StanceLabel stance={pack.stance} />
        <span className="mt-auto text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {choice === null
            ? 'Approve its local file on Site packs first.'
            : `v${choice.version} · ${choice.provenanceShort} · SHA-256 ${shortSha(choice.sha256)}…`}
        </span>
      </button>
    </li>
  );
}

/** The catalog. */
export function SiteCatalog({
  packs,
  chosen,
  full,
  onAdd,
  onRemove,
}: {
  readonly packs: readonly SitePackView[];
  readonly chosen: readonly string[];
  /** The template holds the most sites it may (adding waits; removing still works). */
  readonly full: boolean;
  readonly onAdd: (pack: SitePackView) => void;
  /** Remove these chosen sites (the ones the pack's card covers). */
  readonly onRemove: (sites: readonly string[]) => void;
}) {
  const [q, setQ] = useState('');
  const searchId = useId();
  const shown = filterCatalog(packs, q);
  return (
    <section aria-labelledby={`${searchId}-title`} className="@container flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 id={`${searchId}-title`} className="text-base font-semibold">
            Sites BrowserHive knows
          </h3>
          <p className="text-sm text-muted-foreground">
            A site pack knows how the site signs in, which requests sign you out or change the
            account, and what its terms say.
          </p>
        </div>
        <label htmlFor={searchId} className="sr-only">
          Search sites
        </label>
        <Input
          id={searchId}
          type="search"
          value={q}
          placeholder="Search sites…"
          className="w-full sm:w-64"
          onChange={(event) => setQ(event.target.value)}
        />
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No pack matches “{q.trim()}”. Add it below as another site.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          {shown.map((pack) => {
            const covered = sitesOfPack(pack, chosen);
            return (
              <PackCard
                key={pack.pack_id}
                pack={pack}
                added={covered.length > 0}
                onToggle={() => {
                  if (covered.length > 0) onRemove(covered);
                  else if (!full) onAdd(pack);
                }}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
