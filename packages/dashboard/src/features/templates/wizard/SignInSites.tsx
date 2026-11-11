/** @module features/templates/wizard/SignInSites — the sign-in step's site list (spec 13 §7.1): each site with its state as text and icon (`data-state` for tests), **I'm signed in** for a site without a pack (it learns the cookies that appeared since the window opened), a refusal on the site's row, and a polite live summary when a site's state changes ("2 of 3 sites signed in. site-a.test signed in.") */
import type { TemplateHealthState } from '@browserhive/contracts/enums';
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useEffect, useRef, useState } from 'react';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { HealthIcon } from '../SiteChips.tsx';

/** What changed between two readings, for the live summary (pure, tested). */
export function signInAnnouncement(
  before: ReadonlyMap<string, TemplateHealthState>,
  sites: readonly Pick<TemplateSiteView, 'site_id' | 'health'>[],
): string | null {
  const changed = sites.filter(
    (s) => before.has(s.site_id) && before.get(s.site_id) !== s.health.state,
  );
  if (changed.length === 0) return null;
  const signedIn = sites.filter((s) => s.health.state === 'signed_in').length;
  const parts = changed.map(
    (s) => `${s.site_id} ${SITE_HEALTH[s.health.state].label.toLowerCase()}.`,
  );
  return `${signedIn} of ${sites.length} sites signed in. ${parts.join(' ')}`;
}

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
  const previous = useRef<ReadonlyMap<string, TemplateHealthState>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const said = signInAnnouncement(previous.current, sites);
    if (said !== null) setAnnouncement(said);
    previous.current = new Map(sites.map((s) => [s.site_id, s.health.state] as const));
  }, [sites]);
  return (
    <div className="flex max-w-3xl min-w-0 flex-col">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ul aria-label="Sites" className="flex flex-col divide-y rounded-lg border">
        {sites.map((site) => {
          const state = site.health.state;
          const signedIn = state === 'signed_in';
          const error = errors[site.site_id];
          const label = signedIn ? 'Confirm again' : 'I’m signed in';
          return (
            <li key={site.site_id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <HealthIcon state={state} className="size-4" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-base">{site.site_id}</span>
                  <span
                    data-state={state}
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
                    aria-label={`${label}: ${site.site_id}`}
                    onClick={() => onConfirm(site.site_id)}
                  >
                    {pending === site.site_id ? <Spinner /> : null}
                    {label}
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
    </div>
  );
}
