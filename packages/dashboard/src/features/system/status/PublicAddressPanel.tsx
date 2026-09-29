/** @module features/system/status/PublicAddressPanel — System › Status: the `publicUrl` (or "Not set" and what that means for notification links), the check's outcome as a status dot and sentence, when it ran and "Check again", the trusted-host note, the plain-http warning and a hint when the dashboard is open at another address (D-37, 08 §5.8, spec 04 §12.10) */
import type { PublicUrlStatus } from '@browserhive/contracts/http';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonKv } from '@/components/shared/Skeletons.tsx';
import { StatusDot } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { PUBLIC_URL_OUTCOME } from '@/lib/status-registry.ts';
import { usePublicUrl, useRefreshPublicUrl } from '../api.ts';

/** The origin of an absolute URL, or `null`. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Whether the dashboard is being viewed at an address other than `publicUrl` (and not on this computer). */
export function viewedElsewhere(status: PublicUrlStatus, here: string): boolean {
  if (status.url === null) return false;
  const want = originOf(status.url);
  const local = originOf(status.local_url);
  return want !== null && here !== want && here !== local;
}

/** What each outcome means, in one or two sentences. */
export const OUTCOME_TEXT: { readonly [K in PublicUrlStatus['outcome']]: string } = {
  ok: 'The address answers with this BrowserHive: links in notifications open this dashboard.',
  elsewhere:
    'Another server answered at this address. Links in notifications would open something else: check the proxy or tunnel target.',
  login:
    'The address answers, but a login or an access gate is in front of it (Cloudflare Access, a proxy login), so it cannot be confirmed from here. That is often fine: send a test and tap Open dashboard on your phone.',
  unreachable:
    'This machine cannot reach the address. It may still work from outside (routers often do not loop back): send a test and tap Open dashboard on your phone.',
  unset:
    'Links in notifications point at this computer and only open here. Set publicUrl to the address where you reach this dashboard (a reverse proxy, a tunnel or a Tailscale name) so they open on your phone.',
};

/** The public-address panel. */
export function PublicAddressPanel() {
  const status = usePublicUrl();
  const refresh = useRefreshPublicUrl();
  const Refresh = ICONS.refresh;
  const Warn = ICONS.warn;
  const Info = ICONS.info;
  const Shield = ICONS.secured;
  const data = status.data;
  const here = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <Panel
      title="Public address"
      info={
        <>
          <p>
            <code>publicUrl</code> is where you made this dashboard reachable from elsewhere. Every
            link in a notification uses it, and its host is trusted like <code>allowedHosts</code>.
          </p>
          <p>
            The check fetches <code>&lt;publicUrl&gt;/health</code> from this machine and compares
            this start's instance id. BrowserHive provides no proxy or tunnel of its own.
          </p>
        </>
      }
      infoDocs="publicAddress"
      actions={
        data?.configured === true ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? <Spinner /> : <Refresh aria-hidden="true" />}
            Check again
          </Button>
        ) : undefined
      }
    >
      {data === undefined ? (
        <SkeletonKv count={3} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {data.url !== null ? (
                <a
                  href={data.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-base break-all text-link hover:underline"
                >
                  {data.url}
                </a>
              ) : (
                <span className="text-base font-medium">Not set</span>
              )}
              <StatusDot entry={PUBLIC_URL_OUTCOME[data.outcome]} className="text-sm" />
            </div>
            <p className="max-w-prose text-sm text-muted-foreground">
              {OUTCOME_TEXT[data.outcome]}
              {data.detail !== '' && data.outcome !== 'unset' ? (
                <span className="mt-1 block font-mono text-xs text-subtle-foreground [overflow-wrap:anywhere]">
                  {data.detail}
                  {data.status_code !== null ? ` (HTTP ${data.status_code})` : ''}
                </span>
              ) : null}
            </p>
            {data.checked_at !== null ? (
              <p className="text-xs text-muted-foreground">
                Checked <RelativeTime at={data.checked_at} />
              </p>
            ) : null}
          </div>
          {data.insecure ? (
            <p className="flex gap-2 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn-text">
              <Warn aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              This address uses plain http on a host that is not this computer: logins and links
              travel unencrypted. Put TLS in front (Caddy, Cloudflare, Tailscale HTTPS).
            </p>
          ) : null}
          {viewedElsewhere(data, here) ? (
            <p className="flex gap-2 rounded-md bg-info-bg px-3 py-2 text-sm text-info-text">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              You are viewing the dashboard at {here}, not at the public address. Links in
              notifications open {data.url}.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {data.configured ? (
              <span className="inline-flex items-center gap-1.5">
                <Shield aria-hidden="true" className="size-4" />
                Host {data.host_trusted ? 'trusted' : 'not trusted'} for requests and sign-in
              </span>
            ) : null}
            <span>
              Local address <span className="font-mono">{data.local_url}</span>
            </span>
            <a
              href={docsUrl('publicAddress')}
              target="_blank"
              rel="noreferrer"
              className="text-link hover:underline"
            >
              How to set it up
            </a>
          </div>
        </div>
      )}
    </Panel>
  );
}
