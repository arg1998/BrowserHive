/** @module features/templates/detail/SitesTab — the Sites tab (spec 13 §11.4): one card per sign-in (sites that share a login sit together), with health and why, the cookies that detect the sign-in, the enabled switch, the write policy and Remove site… ; `?site=` brings a card into view */
import type { TemplateDetailResponse, TemplateSiteView } from '@browserhive/contracts/http';
import { useEffect, useId, useRef } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useTemplateOperations } from '../api-operations.ts';
import { removeSiteConfirm } from '../confirm-copy.ts';
import { healthReasonText, signInGroups } from '../model.ts';
import { HealthIcon } from '../SiteChips.tsx';

const POLICY_OPTIONS = [
  { value: 'default', label: 'Site default' },
  { value: 'allow', label: 'Allow' },
  { value: 'warn', label: 'Warn' },
  { value: 'confirm', label: 'Ask me first' },
] as const;

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 text-base">{children}</div>
    </div>
  );
}

function SiteCard({
  templateId,
  site,
  title,
  last,
  focused,
}: {
  readonly templateId: string;
  readonly site: TemplateSiteView;
  readonly title: string;
  readonly last: boolean;
  readonly focused: boolean;
}) {
  const ops = useTemplateOperations(templateId);
  const confirm = useConfirm();
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();
  const switchId = useId();
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);
  const reason = healthReasonText(site.health.reason);
  const cookies = site.learned_cookie_names;
  const Remove = ICONS.delete;
  const onRemove = async () => {
    if (!(await confirm(removeSiteConfirm(site.site_id)))) return;
    ops.deleteSite.mutate(site.site_id);
  };
  const removeButton = (
    <Button
      type="button"
      variant="destructive-ghost"
      size="sm"
      disabled={last || ops.deleteSite.isPending}
      onClick={() => void onRemove()}
    >
      <Remove aria-hidden="true" />
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
        !site.enabled && 'bg-muted/40 dark:bg-white/[0.015]',
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
            <span>{reason ?? 'Not checked yet.'}</span>
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
              Nothing yet. BrowserHive learns the sign-in cookies when you press I’m signed in.
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
                ops.putSite.mutate({ site: site.site_id, body: { enabled } })
              }
            />
            <label htmlFor={switchId} className="text-base">
              {site.enabled ? 'On' : 'Off: kept signed in, not checked or offered'}
            </label>
          </div>
        </Row>
        <Row label="Account changes">
          <div className="flex flex-col gap-1.5">
            <SimpleSelect
              aria-label={`Write policy for ${site.site_id}`}
              size="sm"
              className="w-48"
              value={site.write_policy ?? 'default'}
              disabled={ops.putSite.isPending}
              options={POLICY_OPTIONS}
              onValueChange={(value) =>
                ops.putSite.mutate({
                  site: site.site_id,
                  body: {
                    write_policy:
                      value === 'default' ? null : (value as 'allow' | 'warn' | 'confirm'),
                  },
                })
              }
            />
            <p className="text-sm text-muted-foreground">
              What happens to requests that change the account. Takes effect with site packs.
            </p>
          </div>
        </Row>
      </div>
      <div className="mt-auto flex justify-end border-t px-5 py-2.5">
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

/** Sites tab. */
export function SitesTab({
  detail,
  focusSite,
}: {
  readonly detail: TemplateDetailResponse;
  readonly focusSite: string | undefined;
}) {
  const groups = signInGroups(detail.sites);
  const last = detail.sites.length <= 1;
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      {groups.flatMap((group) =>
        group.sites.map((site) => (
          <SiteCard
            key={site.site_id}
            templateId={detail.template.template_id}
            site={site}
            title={group.title}
            last={last}
            focused={focusSite === site.site_id}
          />
        )),
      )}
    </div>
  );
}
