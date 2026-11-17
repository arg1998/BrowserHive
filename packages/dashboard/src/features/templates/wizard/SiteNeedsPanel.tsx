/** @module features/templates/wizard/SiteNeedsPanel — what the chosen sites' packs need from step 3's settings (spec 13 §9.4 `stealth-profile`, `humanize-input`, §11.1): one row per need with whether the settings meet it and a one-click fix when they do not (the server refuses a template below a site's floor; forced humanized input with stealth off is advisory: it says what is not applied, and the template is still created); and the short chips the chosen-site card shows */
import { Chip } from '@/components/shared/Chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import {
  humanizeAdvisory,
  humanizeUnmet,
  type NeedsSettings,
  needChips,
  type SiteNeeds,
  type UnmetNeed,
  unmetNeeds,
} from './site-needs.ts';

/** One row: what the site needs and whether the settings meet it. */
interface NeedRow {
  readonly key: string;
  readonly title: string;
  readonly label: string;
  readonly fix: UnmetNeed | null;
  readonly fixLabel: string;
  /** Not met, but the template can still be created (what happens instead, in words). */
  readonly advisory?: string;
}

function rowsOf(needs: SiteNeeds, s: NeedsSettings): NeedRow[] {
  const unmet = unmetNeeds(needs, s);
  const fixOf = (field: UnmetNeed['field']) => unmet.find((u) => u.field === field) ?? null;
  const rows: NeedRow[] = [];
  if (needs.minStealth !== null) {
    rows.push({
      key: 'stealth',
      title: needs.title,
      label:
        needs.minStealth === 'max' ? 'Hide automation: Max' : 'Hide automation: Standard or Max',
      fix: fixOf('stealth'),
      fixLabel: needs.minStealth === 'max' ? 'Use Max' : 'Use Standard',
    });
  }
  if (needs.fingerprint !== null) {
    rows.push({
      key: 'fingerprint',
      title: needs.title,
      label:
        needs.fingerprint === 'required'
          ? 'Consistent fingerprint: on'
          : 'Consistent fingerprint: off (the site flags fingerprint noise)',
      fix: fixOf('fingerprint'),
      fixLabel: needs.fingerprint === 'required' ? 'Turn on' : 'Turn off',
    });
  }
  if (needs.headed) {
    rows.push({
      key: 'headless',
      title: needs.title,
      label: 'A visible browser (headless off)',
      fix: fixOf('headless'),
      fixLabel: 'Turn headless off',
    });
  }
  if (humanizeAdvisory(needs)) {
    rows.push({
      key: 'humanize',
      title: needs.title,
      label: 'Humanized input needs stealth on (Hide automation Standard or Max)',
      fix: humanizeUnmet(needs, s),
      fixLabel: 'Turn stealth on',
      advisory:
        'With stealth off it is not applied: clicks and typing on the site stay native and instant. You can still create the template.',
    });
  }
  return rows;
}

/** Step 3's checklist of the chosen sites' needs; nothing when no site needs anything. */
export function SiteNeedsPanel({
  needs,
  settings,
  onFix,
}: {
  readonly needs: readonly SiteNeeds[];
  readonly settings: NeedsSettings;
  readonly onFix: (fix: UnmetNeed) => void;
}) {
  if (needs.length === 0) return null;
  const rows = needs.flatMap((n) => rowsOf(n, settings).map((r) => ({ ...r, site: n.site })));
  const open = rows.filter((r) => r.fix !== null && r.advisory === undefined).length;
  const advised = rows.filter((r) => r.fix !== null && r.advisory !== undefined).length;
  return (
    <section
      aria-labelledby="site-needs-title"
      className={cn(
        'flex max-w-3xl flex-col gap-3 rounded-lg border p-4',
        open + advised > 0 ? 'border-warn-border bg-warn-bg/40' : 'bg-surface-inset',
      )}
    >
      <div className="flex flex-col gap-0.5">
        <h3 id="site-needs-title" className="text-base font-semibold">
          What your sites need
        </h3>
        <p className="text-sm text-pretty text-muted-foreground">
          {open > 0
            ? 'Some site packs need other settings here; the template can’t be created until they’re met.'
            : advised > 0
              ? 'A site pack asks for a setting that’s off here. The template can still be created, without it.'
              : 'These settings meet every site pack’s needs.'}
        </p>
      </div>
      <ul className="flex flex-col divide-y rounded-md border bg-card">
        {rows.map((row) => {
          const Icon = row.fix === null ? ICONS.success : ICONS.warn;
          return (
            <li
              key={`${row.site}:${row.key}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
            >
              <Icon
                aria-hidden="true"
                className={cn(
                  'size-4 shrink-0',
                  row.fix === null ? 'text-success-text' : 'text-warn-text',
                )}
              />
              <span className="flex min-w-0 flex-1 basis-48 flex-col">
                <bdi className="text-sm font-medium">{row.title}</bdi>
                <span className="text-sm text-pretty text-muted-foreground">
                  {row.label}
                  <span className="sr-only">{row.fix === null ? ': met' : ': not met'}</span>
                </span>
                {row.fix !== null && row.advisory !== undefined ? (
                  <span className="mt-0.5 text-sm text-pretty text-warn-text">{row.advisory}</span>
                ) : null}
              </span>
              {row.fix !== null ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`${row.fixLabel} for ${row.title}`}
                  onClick={() => {
                    if (row.fix !== null) onFix(row.fix);
                  }}
                >
                  {row.fixLabel}
                </Button>
              ) : (
                <span className="text-sm text-success-text">Met</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The chosen-site card's chips for a site's needs. */
export function NeedChips({ needs }: { readonly needs: SiteNeeds | null }) {
  if (needs === null) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {needChips(needs).map((chip) => (
        <Chip key={chip} tone="accent">
          {chip}
        </Chip>
      ))}
    </span>
  );
}
