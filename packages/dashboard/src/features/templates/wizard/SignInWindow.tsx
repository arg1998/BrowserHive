/** @module features/templates/wizard/SignInWindow — while the sign-in window is open: where it is, what to do in it, and **Watch the window**: its live view, view only, labelled so nobody tries to sign in through the preview; under the site list, at the width of the card so the page stays readable */
import type { SessionSummary } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { LivePane } from '@/features/sessions/live/LivePane.tsx';
import { ICONS } from '@/lib/icons.ts';

/** Header line of an open window, with the watch toggle. */
export function SignInWindowHeader({
  remote,
  watching,
  onWatch,
}: {
  readonly remote: string | null;
  readonly watching: boolean;
  readonly onWatch: (on: boolean) => void;
}) {
  const Eye = ICONS.show;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex max-w-3xl min-w-0 flex-col gap-0.5">
        <p className="text-base font-medium">
          The sign-in window is open{' '}
          {remote !== null ? `on ${remote}` : 'on the machine running BrowserHive'}
        </p>
        <p className="text-sm text-pretty text-muted-foreground">
          One tab per site. Sign in as you normally would, then press I’m signed in for each site.
          Saved passwords and password-manager extensions aren’t available there.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={watching}
        onClick={() => onWatch(!watching)}
      >
        <Eye aria-hidden="true" />
        {watching ? 'Hide the window' : 'Watch the window'}
      </Button>
    </div>
  );
}

/** The site list with the live view beside it (wide) or under it. */
export function SignInWindowLayout({
  session,
  watching,
  remote,
  onStopWatching,
  children,
}: {
  readonly session: SessionSummary | null;
  readonly watching: boolean;
  readonly remote: string | null;
  readonly onStopWatching: () => void;
  readonly children: ReactNode;
}) {
  const show = watching && session !== null;
  return (
    <div className="@container min-w-0">
      <div className={show ? 'flex flex-col gap-4' : undefined}>
        {children}
        {show ? (
          <section
            aria-label="Live view of the sign-in window"
            className="flex min-w-0 flex-col gap-2"
          >
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <ICONS.show aria-hidden="true" className="size-4" />
              View only. Sign in in the window itself
              {remote !== null ? `, on ${remote}` : ''}.
            </p>
            <LivePane
              session={session}
              takeover={null}
              gateKnown
              vaultEnabled={false}
              armTakeover={false}
              onArmed={() => undefined}
              onClose={onStopWatching}
              layout="stacked"
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}
