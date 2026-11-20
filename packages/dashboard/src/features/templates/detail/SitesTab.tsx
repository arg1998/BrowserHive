/** @module features/templates/detail/SitesTab — the Sites tab (spec 13 §11.4): **Check all** sites now (the toast counts sites not signed in apart from those it couldn't tell about), then one card per sign-in (sites that share a login sit together, `SiteCard`); while the template is still being set up, one notice with **Continue sign-in** instead of per-card hints; `?site=` brings a card into view */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useProbePending, useTemplateHealth } from '../api-health.ts';
import { CUT_SHORT, needsSignIn, signInGroups } from '../model.ts';
import { SiteCard } from './SiteCard.tsx';

/** `6 hours`, `30 minutes`, `day` (after "every"). */
export function intervalText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const [n, unit] =
    minutes % 1440 === 0
      ? [minutes / 1440, 'day']
      : minutes % 60 === 0
        ? [minutes / 60, 'hour']
        : [minutes, 'minute'];
  return n === 1 ? unit : `${n} ${unit}s`;
}

/** Sites tab. */
export function SitesTab({
  detail,
  focusSite,
  onRelogin,
}: {
  readonly detail: TemplateDetailResponse;
  readonly focusSite: string | undefined;
  readonly onRelogin: (site: string) => void;
}) {
  const { template } = detail;
  const health = useTemplateHealth(template.template_id);
  const toast = useToast();
  const enabled = detail.sites.filter((s) => s.enabled).length;
  const checking = useProbePending(template.template_id);
  const checkAll = () =>
    health.probe.mutate(undefined, {
      onSuccess: (result) => {
        const n = result.results.length;
        const out = result.results.filter((r) => needsSignIn(r.outcome)).length;
        // "Couldn't tell" is not "not signed in" (owner 2026-11-17): it is counted apart.
        const unsure = result.results.filter((r) => r.outcome === 'inconclusive').length;
        const checked = `Checked ${n} ${n === 1 ? 'site' : 'sites'}`;
        // The 2-minute cap passed first (review #81 L-4): say so, whatever was found by then.
        if (result.cut_short) {
          toast.warning({
            title: `${checked}, then stopped after 2 minutes`,
            description: CUT_SHORT,
          });
        } else if (out === 0 && unsure === 0) toast.success({ title: `${checked}: all signed in` });
        else {
          const parts = [
            ...(out > 0 ? [`${out} not signed in`] : []),
            ...(unsure > 0 ? [`${unsure} couldn’t tell`] : []),
          ];
          toast[out > 0 ? 'warning' : 'info']({ title: `${checked}: ${parts.join(', ')}` });
        }
      },
    });
  const groups = signInGroups(detail.sites);
  const last = detail.sites.length <= 1;
  const settingUp = template.status === 'recording';
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {settingUp ? (
        <Callout
          tone="warn"
          title="Not signed in yet"
          action={
            <Link
              to="/templates/new"
              search={{ step: 5, template: template.template_id }}
              className={buttonVariants({ size: 'sm' })}
            >
              <ICONS.signIn aria-hidden="true" />
              Continue sign-in
            </Link>
          }
        >
          Finish setting up: open the sign-in window, sign in to each site and confirm it. Agents
          can’t use the template until then.
        </Callout>
      ) : null}
      {settingUp || detail.sites.length < 2 ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            BrowserHive checks each site every {intervalText(template.policy.health_interval_ms)}{' '}
            and before launches.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={checking || enabled === 0}
            onClick={checkAll}
          >
            {checking ? <Spinner /> : <ICONS.refresh aria-hidden="true" />}
            {checking ? 'Checking…' : 'Check all now'}
          </Button>
        </div>
      )}
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {groups.flatMap((group) =>
          group.sites.map((site) => (
            <SiteCard
              key={site.site_id}
              templateId={template.template_id}
              templateName={template.display_name}
              site={site}
              relogin={detail.relogin?.site_id === site.site_id ? detail.relogin : null}
              machineName={detail.machine.name}
              onRelogin={onRelogin}
              title={group.title}
              last={last}
              settingUp={settingUp}
              focused={focusSite === site.site_id}
            />
          )),
        )}
      </div>
    </div>
  );
}
