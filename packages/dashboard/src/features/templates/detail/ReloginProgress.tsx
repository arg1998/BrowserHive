/** @module features/templates/detail/ReloginProgress — where a site's re-login stands, on its card (spec 13 §8.4): queued until **Show window**, the window open (or the live view to sign in through, for a browser with no window to show) with its deadline and **I'm signed in** (a site without a pack) or **Done** (the site's cookies were already there), a vault fill running, signed in again (with the version written and sign-ins to other sites to remove), or failed with why; cancelled ones are not shown */
import type { ReloginView, TemplateSiteView } from '@browserhive/contracts/http';
import { useRef, useState } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useTemplateDetail, useTemplateMutations } from '../api.ts';
import { useTemplateHealth } from '../api-health.ts';
import {
  LIVE_VIEW_TEXT,
  LiveViewLink,
  liveViewSession,
  useShowWindow,
} from '../LiveViewSignIn.tsx';
import { RELOGIN_STATE_LABEL, reloginErrorText, requesterText } from '../relogin-text.ts';
import { siteCardHeading, useFocusRescue } from './focus-rescue.ts';

/** Why **Done** instead of noticing the sign-in (review #81 M-5). */
export const CONFIRM_REQUIRED_TEXT =
  'This site’s sign-in cookies were already there, so BrowserHive can’t tell when you’re done. Sign in again if needed, then press Done.';

/** Props. */
export interface ReloginProgressProps {
  readonly templateId: string;
  readonly site: TemplateSiteView;
  readonly relogin: ReloginView;
  readonly machineName: string;
  readonly onRetry: () => void;
}

const TONE = {
  active: 'border-info-border bg-info-bg/60',
  success: 'border-success-border bg-success-bg/60',
  danger: 'border-danger-border bg-danger-bg/60',
} as const;

/** Sign-ins to domains that aren't sites of the template, each with Remove sign-in. */
function UnlistedSignIns({
  templateId,
  domains,
}: {
  readonly templateId: string;
  readonly domains: readonly string[];
}) {
  const mutations = useTemplateMutations(templateId);
  // The page's own notice lists the template's unlisted sign-ins already: only name the others here.
  const listed = useTemplateDetail(templateId).data?.unlisted_domains ?? [];
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const left = domains.filter((d) => !removed.includes(d) && !listed.includes(d));
  if (left.length === 0) return null;
  const removing = mutations.removeSignIn.isPending ? mutations.removeSignIn.variables : undefined;
  return (
    <div className="flex flex-col gap-1.5 border-t border-success-border/60 pt-2">
      <p className="text-sm">
        Also signed in to sites that aren’t part of this template. Agents can use these too:
      </p>
      <ul className="flex flex-col gap-1.5">
        {left.map((domain) => (
          <li key={domain} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-sm">{domain}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={removing !== undefined}
              aria-label={`Remove sign-in to ${domain}`}
              onClick={() =>
                mutations.removeSignIn.mutate(domain, {
                  onSuccess: () => setRemoved((r) => [...r, domain]),
                })
              }
            >
              {removing === domain ? <Spinner /> : null}
              Remove sign-in
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the panel says about a re-login, by state. */
function statusText(
  relogin: ReloginView,
  site: TemplateSiteView,
  machineName: string,
  live: boolean,
): string {
  switch (relogin.state) {
    case 'queued':
      return `Asked for ${requesterText(relogin.requested_by)}. The sign-in window opens on ${machineName} when you press Show window there or here.`;
    case 'open':
      if (live) return LIVE_VIEW_TEXT;
      return `Sign in in the window on ${machineName}.${relogin.agents_paused ? ' Agents wait until it closes.' : ''}`;
    case 'filling':
      return 'BrowserHive is filling the sign-in form with the vault in the background.';
    case 'signed_in':
      return `${site.title} is signed in again${relogin.version !== null ? `; saved as version ${relogin.version}` : ''}.`;
    default:
      return reloginErrorText(relogin.error, relogin.state);
  }
}

/** Progress panel; `null` for a cancelled re-login. */
export function ReloginProgress({
  templateId,
  site,
  relogin,
  machineName,
  onRetry,
}: ReloginProgressProps) {
  const health = useTemplateHealth(templateId);
  const toast = useToast();
  const showWindow = useShowWindow(templateId, relogin);
  const ref = useRef<HTMLElement>(null);
  useFocusRescue(ref, () => siteCardHeading(site.site_id), relogin.state);
  if (relogin.state === 'cancelled') return null;
  const busy = showWindow.pending || health.cancel.isPending || health.confirm.isPending;
  const live = liveViewSession(relogin);
  const active =
    relogin.state === 'queued' || relogin.state === 'open' || relogin.state === 'filling';
  const tone = active ? 'active' : relogin.state === 'signed_in' ? 'success' : 'danger';
  const Icon = active
    ? ICONS.signIn
    : relogin.state === 'signed_in'
      ? ICONS.success
      : ICONS.failure;
  // `confirm_required`: the site's cookies were already there, so only the operator can say when
  // the sign-in is done (review #81 M-5); a site without a pack is confirmed to learn its cookies.
  const confirmLabel = relogin.confirm_required ? 'Done' : 'I’m signed in';
  const confirmable =
    relogin.state === 'open' && (relogin.confirm_required || site.pack_id === null);
  const onCancel = () =>
    health.cancel.mutate(undefined, {
      onSuccess: () => toast.info({ title: `Re-login of ${site.title} cancelled` }),
    });
  return (
    <section
      ref={ref}
      aria-label={`Re-login of ${site.title}`}
      data-relogin={relogin.state}
      className={cn('flex flex-col gap-2 rounded-lg border px-3.5 py-3', TONE[tone])}
    >
      <div className="flex items-start gap-2.5">
        {relogin.state === 'filling' ? (
          <Spinner className="mt-0.5 size-4 shrink-0" />
        ) : (
          <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-medium">{RELOGIN_STATE_LABEL[relogin.state]}</p>
          <p className="text-sm text-pretty">
            {statusText(relogin, site, machineName, live !== null)}
          </p>
          {confirmable && relogin.confirm_required ? (
            <p className="text-sm text-pretty">{CONFIRM_REQUIRED_TEXT}</p>
          ) : null}
          {relogin.state === 'open' && relogin.deadline_at !== null ? (
            <p className="text-sm text-muted-foreground">
              {live !== null ? 'The sign-in ends by itself' : 'The window closes by itself'}{' '}
              <RelativeTime at={relogin.deadline_at} className="min-w-0 text-sm" />
            </p>
          ) : null}
          {!active && relogin.finished_at !== null ? (
            <p className="text-sm text-muted-foreground">
              <RelativeTime at={relogin.finished_at} className="min-w-0 text-sm" />
            </p>
          ) : null}
        </div>
      </div>
      {relogin.state === 'signed_in' && relogin.unlisted_domains.length > 0 ? (
        <UnlistedSignIns templateId={templateId} domains={relogin.unlisted_domains} />
      ) : null}
      {relogin.state === 'queued' || relogin.state === 'open' ? (
        <div className="flex flex-wrap items-center gap-2 pl-6.5">
          {live !== null ? <LiveViewLink sessionId={live} size="xs" /> : null}
          {confirmable ? (
            <Button
              type="button"
              size="xs"
              variant={live !== null ? 'outline' : 'default'}
              disabled={busy}
              aria-label={`${confirmLabel}: ${site.title}`}
              onClick={() => health.confirm.mutate(site.site_id)}
            >
              {health.confirm.isPending ? <Spinner /> : <ICONS.check aria-hidden="true" />}
              {confirmLabel}
            </Button>
          ) : null}
          {live === null ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={showWindow.show}
            >
              <ICONS.external aria-hidden="true" />
              Show window
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel re-login
          </Button>
        </div>
      ) : relogin.state === 'failed' || relogin.state === 'timed_out' ? (
        <div className="pl-6.5">
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            <ICONS.retry aria-hidden="true" />
            Try again…
          </Button>
        </div>
      ) : null}
    </section>
  );
}
