/** @module features/templates/detail/SiteCard — one site of the Sites tab (spec 13 §11.4): its sign-in (state, why, last check, **Check now**, the couldn't-tell warning), its re-login in progress, the cookies that detect it, whether agents are offered it, automatic re-login with the vault, its site pack (version and source, the terms, the write policy, rule counts; or "Use the … site pack" for a generic site), what the pack asks for that the template or machine cannot apply (`SiteStrategyNotes`), **Clear stop** for a stopped site, **Re-login…** and Remove site… */
import type { ReloginView, TemplateSiteView } from '@browserhive/contracts/http';
import { useEffect, useId, useRef } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useTemplateOperations } from '../api-operations.ts';
import { removeSiteConfirm } from '../confirm-copy.ts';
import { needsSignIn } from '../model.ts';
import { HealthIcon } from '../SiteChips.tsx';
import { ClearStop } from './ClearStop.tsx';
import { DeviceBoundBadge } from './DeviceBoundBadge.tsx';
import { ReloginProgress } from './ReloginProgress.tsx';
import { CheckNowButton, SiteHealth, useCheckNow } from './SiteHealth.tsx';
import { SitePackRows } from './SitePackRows.tsx';
import { SiteStrategyNotes } from './SiteStrategyNotes.tsx';
import { Row } from './site-row.tsx';
import { VaultRelogin } from './VaultRelogin.tsx';

/** Props. `settingUp`: the template's first sign-in is not finished (the page says so once). */
export interface SiteCardProps {
  readonly templateId: string;
  readonly templateName: string;
  readonly site: TemplateSiteView;
  readonly title: string;
  readonly last: boolean;
  readonly focused: boolean;
  readonly settingUp: boolean;
  /** The template's re-login when it is about this site. */
  readonly relogin: ReloginView | null;
  readonly machineName: string;
  readonly onRelogin: (site: string) => void;
}

/** One site. */
export function SiteCard({
  templateId,
  templateName,
  site,
  title,
  last,
  focused,
  settingUp,
  relogin,
  machineName,
  onRelogin,
}: SiteCardProps) {
  const ops = useTemplateOperations(templateId);
  const confirm = useConfirm();
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();
  const switchId = useId();
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);
  const check = useCheckNow(templateId, site);
  const cookies = site.learned_cookie_names;
  const needed = needsSignIn(site.health.state);
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
          {/* `tabIndex={-1}`: focus lands here when a control of the card goes away (`focus-rescue`). */}
          <h2
            id={headingId}
            tabIndex={-1}
            className="truncate rounded-sm text-base font-semibold focus-ring"
          >
            {title}
          </h2>
          {title !== site.site_id ? (
            <span className="truncate font-mono text-sm text-muted-foreground">{site.site_id}</span>
          ) : null}
          <DeviceBoundBadge bound={site.device_bound} />
        </div>
        <StatusBadge domain="siteHealth" value={site.health.state} variant="pill" iconless />
      </div>
      {site.stopped_at !== null ? (
        <div className="px-5 pt-4">
          <ClearStop templateId={templateId} site={site} />
        </div>
      ) : null}
      {relogin !== null ? (
        <div className="px-5 pt-4">
          <ReloginProgress
            templateId={templateId}
            site={site}
            relogin={relogin}
            machineName={machineName}
            onRetry={() => onRelogin(site.site_id)}
          />
        </div>
      ) : null}
      <SiteStrategyNotes notes={site.strategy_notes} />
      <div className="flex flex-col divide-y px-5 py-4">
        <Row label="Sign-in">
          <SiteHealth site={site} settingUp={settingUp} checking={check.mine} />
        </Row>
        <Row label="Detected by">
          {site.pack !== null ? (
            <p>
              The <bdi>{site.pack.title}</bdi> site pack’s signed-in check
            </p>
          ) : cookies.length > 0 ? (
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
        <Row label="Automatic re-login">
          <VaultRelogin templateId={templateId} templateName={templateName} site={site} />
        </Row>
        <SitePackRows templateId={templateId} site={site} />
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2.5">
        {settingUp ? (
          <span />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={needed ? 'default' : 'outline'}
              size="sm"
              aria-label={`Re-login: ${site.site_id}`}
              onClick={() => onRelogin(site.site_id)}
            >
              <ICONS.signIn aria-hidden="true" />
              Re-login…
            </Button>
            <CheckNowButton site={site} checking={check.checking} onCheck={check.checkNow} />
          </div>
        )}
        {/* `ml-auto`: Remove stays at the end of the line when the footer wraps on a phone. */}
        <div className="ml-auto">
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
      </div>
    </section>
  );
}
