/** @module features/templates/detail/SiteHealth — a site's sign-in on its card (spec 13 §8): why it is in that state, when it was last checked (live over the `templates` topic), the warning after three checks in a row that couldn't tell, and **Check now** (`useCheckNow`, `CheckNowButton` in the card's footer) */
import type { TemplateHealthState } from '@browserhive/contracts/enums';
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useMutationState } from '@tanstack/react-query';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { keys } from '@/lib/api/keys.ts';
import { ICONS } from '@/lib/icons.ts';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { useTemplateHealth } from '../api-health.ts';
import { healthReasonText, inconclusiveWarning, needsSignIn } from '../model.ts';

/** The toast of a check's outcome: green only when signed in (review #81 L-18). */
export function checkToastKind(outcome: TemplateHealthState): 'success' | 'warning' | 'info' {
  if (outcome === 'signed_in') return 'success';
  return needsSignIn(outcome) ? 'warning' : 'info';
}

/**
 * **Check now** for one site: probes it and says what the check found. `checking` is shared by every
 * Check now and Check all now of the template (one runs at a time, review #81 L-16); `mine` is
 * whether this site is among the sites being checked.
 */
export function useCheckNow(templateId: string, site: TemplateSiteView) {
  const health = useTemplateHealth(templateId);
  const toast = useToast();
  const running = useMutationState({
    filters: { mutationKey: keys.templates.probeRun(templateId), status: 'pending' },
    select: (m) => m.state.variables as readonly string[] | undefined,
  });
  const checkNow = () =>
    health.probe.mutate([site.site_id], {
      onSuccess: (result) => {
        const mine = result.results.find((r) => r.site_id === site.site_id);
        if (mine === undefined) return;
        const why = healthReasonText(mine.reason);
        toast[checkToastKind(mine.outcome)]({
          title: `${site.title}: ${SITE_HEALTH[mine.outcome].label.toLowerCase()}`,
          ...(why !== null && { description: why }),
        });
      },
    });
  return {
    checking: running.length > 0,
    mine: running.some((ids) => ids === undefined || ids.includes(site.site_id)),
    checkNow,
  };
}

/** The Check now button (card footer). */
export function CheckNowButton({
  site,
  checking,
  onCheck,
}: {
  readonly site: TemplateSiteView;
  readonly checking: boolean;
  readonly onCheck: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={checking || !site.enabled}
      aria-label={`Check now: ${site.site_id}`}
      onClick={onCheck}
    >
      {checking ? <Spinner /> : <ICONS.refresh aria-hidden="true" />}
      {checking ? 'Checking…' : 'Check now'}
    </Button>
  );
}

/** The words of a site's sign-in and its last check. */
export function SiteHealth({
  site,
  settingUp,
  checking,
}: {
  readonly site: TemplateSiteView;
  readonly settingUp: boolean;
  readonly checking: boolean;
}) {
  const reason = healthReasonText(site.health.reason);
  const warning = inconclusiveWarning(site);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex min-w-0 flex-col">
        <span>{reason ?? (settingUp ? 'Not signed in yet.' : 'Not checked yet.')}</span>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {checking ? (
            'Checking…'
          ) : site.health.checked_at !== null ? (
            <>
              Last checked <RelativeTime at={site.health.checked_at} className="min-w-0 text-sm" />
            </>
          ) : null}
        </span>
      </p>
      {warning !== null ? (
        <p className="flex items-start gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-text">
          <ICONS.warn aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">{warning}.</span> The last{' '}
            {site.health.consecutive_inconclusive} checks found neither a sign-in nor a sign-out.
            Open a session and look, or Re-login to be sure.
          </span>
        </p>
      ) : null}
    </div>
  );
}
