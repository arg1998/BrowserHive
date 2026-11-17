/** @module features/templates/wizard/ChosenSite — one chosen site on wizard step 2 (spec 13 §7.1, §9.3, §9.6): a site a pack covers names the pack and the version creating the template approves (whether it was picked from the catalog or typed, also before the catalog loaded), says when you sign in by hand only, what the pack needs from the template's settings (a stealth floor, fingerprint noise on or off, a visible browser) and when the pack guards no writes yet, and quotes the site's terms clause with its checked date and address as text (review S-L1, S-M4); any other site is a generic site */
import type { SitePackView } from '@browserhive/contracts/http';
import { Button } from '@/components/ui/button.tsx';
import { useSitePack } from '@/features/site-packs/api.ts';
import { NO_WRITE_GUARDS, packNote } from '@/features/site-packs/model.ts';
import { StanceLabel, TermsClause } from '@/features/site-packs/PackBits.tsx';
import { ICONS } from '@/lib/icons.ts';
import { NeedChips } from './SiteNeedsPanel.tsx';
import { siteNeedsOf } from './site-needs.ts';

/** What the site needs from the template and the pack's terms clause, read from the pack's content (the list view carries neither). */
function PackFacts({ pack, site }: { readonly pack: SitePackView; readonly site: string }) {
  const detail = useSitePack(pack.pack_id);
  const content = detail.data?.pack;
  const clause = content?.write_policy.clause;
  return (
    <span className="flex min-w-0 flex-col gap-1.5">
      <NeedChips needs={content == null ? null : siteNeedsOf(site, pack.title, content)} />
      <StanceLabel stance={pack.stance} />
      {clause !== undefined ? <TermsClause clause={clause} /> : null}
    </span>
  );
}

/** A chosen site. `sha256`: the hash chosen when it was added, if any. */
export function ChosenSite({
  site,
  sha256,
  packs,
  onRemove,
}: {
  readonly site: string;
  readonly sha256: string | undefined;
  readonly packs: readonly SitePackView[];
  readonly onRemove: () => void;
}) {
  const note = packNote(packs, site);
  const Icon = note === null && sha256 === undefined ? ICONS.globe : ICONS.sitePacks;
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-lg border bg-surface-inset p-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="truncate font-mono text-base">
          {note !== null ? (
            <>
              <bdi>{note.pack.title}</bdi> · {site}
            </>
          ) : (
            site
          )}
        </span>
        <span className="text-sm text-pretty text-muted-foreground [overflow-wrap:anywhere]">
          {note !== null
            ? note.text
            : sha256 !== undefined
              ? `Adds its site pack (SHA-256 ${sha256.slice(0, 12)}…)`
              : 'BrowserHive learns its sign-in when you confirm it'}
        </span>
        {note?.pack.human_only === true ? (
          <span className="text-sm text-warn-text">
            Sign in by hand only: you sign in yourself, and automatic re-login is unavailable.
          </span>
        ) : null}
        {note !== null && note.pack.write_guards === 0 ? (
          <span className="text-sm text-muted-foreground">{NO_WRITE_GUARDS}</span>
        ) : null}
        {note !== null ? <PackFacts pack={note.pack} site={site} /> : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${site}`}
        onClick={onRemove}
      >
        <ICONS.close aria-hidden="true" />
      </Button>
    </li>
  );
}
