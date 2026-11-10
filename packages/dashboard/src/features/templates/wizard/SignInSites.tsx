/** @module features/templates/wizard/SignInSites — the sign-in step's site list (spec 13 §7.1): each site with its tick (Signed in, Signed out, Check needed, Couldn't tell, Not checked yet) and, for a site without a pack, **I'm signed in**, which learns the cookies that appeared on it since the window opened; a refusal ("no new cookies yet") is shown on the site's row */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { HealthIcon } from '../SiteChips.tsx';

/** Site rows. */
export function SignInSites({
  sites,
  windowOpen,
  pending,
  errors,
  onConfirm,
}: {
  readonly sites: readonly TemplateSiteView[];
  readonly windowOpen: boolean;
  /** The site whose confirmation is in flight. */
  readonly pending: string | null;
  readonly errors: Readonly<Record<string, string>>;
  readonly onConfirm: (siteId: string) => void;
}) {
  return (
    <ul aria-label="Sites" className="flex flex-col divide-y rounded-lg border">
      {sites.map((site) => {
        const state = site.health.state;
        const signedIn = state === 'signed_in';
        const error = errors[site.site_id];
        return (
          <li key={site.site_id} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <HealthIcon state={state} className="size-4" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-base">{site.site_id}</span>
                <span
                  className={cn(
                    'text-sm',
                    signedIn ? 'text-success-text' : 'text-muted-foreground',
                  )}
                >
                  {state === 'unknown' ? 'Not signed in yet' : SITE_HEALTH[state].label}
                  {signedIn && site.health.changed_at !== null ? (
                    <>
                      {' · '}
                      <RelativeTime at={site.health.changed_at} className="min-w-0" />
                    </>
                  ) : null}
                </span>
              </span>
              {site.pack_id === null && windowOpen ? (
                <Button
                  type="button"
                  size="sm"
                  variant={signedIn ? 'ghost' : 'outline'}
                  disabled={pending !== null}
                  aria-label={`I'm signed in to ${site.site_id}`}
                  onClick={() => onConfirm(site.site_id)}
                >
                  {pending === site.site_id ? <Spinner /> : null}
                  {signedIn ? 'Confirm again' : 'I’m signed in'}
                </Button>
              ) : null}
            </div>
            {error !== undefined ? (
              <p role="alert" className="pl-7 text-sm text-warn-text">
                {error}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
