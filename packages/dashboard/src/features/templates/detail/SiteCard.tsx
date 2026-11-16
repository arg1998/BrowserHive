/** @module features/templates/detail/SiteCard — one site of the Sites tab (spec 13 §11.4): its sign-in (state, why, last check), the cookies that detect it, whether agents are offered it, the account-change rule (read only until site packs), **Sign in again** for a site that is not signed in, and Remove site… */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useTemplateOperations } from '../api-operations.ts';
import { removeSiteConfirm } from '../confirm-copy.ts';
import { healthReasonText } from '../model.ts';
import { HealthIcon } from '../SiteChips.tsx';

const POLICY_TEXT = {
  allow: 'Allowed',
  warn: 'Allowed with a warning',
  confirm: 'Asks you first',
} as const;

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 text-base text-pretty">{children}</div>
    </div>
  );
}

/** One site. `settingUp`: the template's first sign-in is not finished (the page says so once). */
export function SiteCard({
  templateId,
  site,
  title,
  last,
  focused,
  settingUp,
}: {
  readonly templateId: string;
  readonly site: TemplateSiteView;
  readonly title: string;
  readonly last: boolean;
  readonly focused: boolean;
  readonly settingUp: boolean;
}) {
  const ops = useTemplateOperations(templateId);
  const confirm = useConfirm();
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();
  const switchId = useId();
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);
  const reason = healthReasonText(site.health.reason);
  const cookies = site.learned_cookie_names;
  const signedIn = site.health.state === 'signed_in';
  const onRemove = async () => {
    if (!(await confirm(removeSiteConfirm(site.site_id)))) return;
    ops.deleteSite.mutate(site.site_id, {
      onSuccess: () => toast.success({ title: `Removed ${site.site_id}` }),
    });
  };
  const removeButton = (
    <Button
      type="button"
      variant="destructive-ghost"
      size="sm"
      disabled={last || ops.deleteSite.isPending}
      onClick={() => void onRemove()}
    >
      <ICONS.delete aria-hidden="true" />
      Remove site…
    </Button>
  );
  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      data-site={site.site_id}
      className={cn(
        'flex min-w-0 flex-col rounded-xl border bg-card shadow-xs dark:shadow-none',
        focused && 'ring-2 ring-ring/60',
        !site.enabled && 'bg-surface-inset',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4">
        <div className="flex min-w-0 items-center gap-2">
          <HealthIcon state={site.health.state} className="size-4" />
          <h2 id={headingId} className="truncate text-base font-semibold">
            {title}
          </h2>
          {title !== site.site_id ? (
            <span className="truncate font-mono text-sm text-muted-foreground">{site.site_id}</span>
          ) : null}
        </div>
        <StatusBadge domain="siteHealth" value={site.health.state} variant="pill" iconless />
      </div>
      <div className="flex flex-col divide-y px-5 py-4">
        <Row label="Sign-in">
          <p className="flex flex-col">
            <span>{reason ?? (settingUp ? 'Not signed in yet.' : 'Not checked yet.')}</span>
            {site.health.checked_at !== null ? (
              <span className="text-sm text-muted-foreground">
                Last checked{' '}
                <RelativeTime at={site.health.checked_at} className="min-w-0 text-sm" />
              </span>
            ) : null}
          </p>
        </Row>
        <Row label="Detected by">
          {cookies.length > 0 ? (
            <p>
              {cookies.length} {cookies.length === 1 ? 'cookie' : 'cookies'} BrowserHive learned:{' '}
              <span className="font-mono text-sm [overflow-wrap:anywhere]">
                {cookies.join(', ')}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">
              Nothing learned yet: BrowserHive learns it when you confirm a sign-in.
            </p>
          )}
        </Row>
        <Row label="Offered to agents">
          <div className="flex items-center gap-3">
            <Switch
              id={switchId}
              checked={site.enabled}
              disabled={ops.putSite.isPending}
              onCheckedChange={(enabled: boolean) =>
                ops.putSite.mutate(
                  { site: site.site_id, body: { enabled } },
                  {
                    onSuccess: () =>
                      toast.success({
                        title: enabled
                          ? `${site.site_id} is offered to agents`
                          : `${site.site_id} is no longer offered to agents`,
                      }),
                  },
                )
              }
            />
            <label htmlFor={switchId} className="text-base">
              {site.enabled ? 'On' : 'Off: kept signed in, not checked or offered'}
            </label>
          </div>
        </Row>
        <Row label="Account changes">
          <p className="text-muted-foreground">
            {site.write_policy === null ? 'Site default' : POLICY_TEXT[site.write_policy]} · takes
            effect with site packs
          </p>
        </Row>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2.5">
        {!signedIn && !settingUp ? (
          <Link
            to="/templates/new"
            search={{ step: 5, template: templateId, again: 1 }}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <ICONS.signIn aria-hidden="true" />
            Sign in again
          </Link>
        ) : (
          <span />
        )}
        {last ? (
          <Hint label="A template needs at least one site">
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button cannot take focus, so its wrapper carries the tooltip reason */}
            <span tabIndex={0} className="rounded-md focus-ring">
              {removeButton}
            </span>
          </Hint>
        ) : (
          removeButton
        )}
      </div>
    </section>
  );
}
