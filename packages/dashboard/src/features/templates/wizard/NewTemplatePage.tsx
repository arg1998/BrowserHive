/** @module features/templates/wizard/NewTemplatePage — `/templates/new` (spec 13 §7.1, §11.4): the five-step wizard with a step rail, the step's card (capped in width so its fields and buttons stay together), and the sign-in step for `?template=` (also for signing in again to a ready template); state and rules in `use-wizard.ts` */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { usePageCrumb } from '@/app/shell/page-crumb.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { useVaultEnabled } from '@/features/sessions/api.ts';
import { keys } from '@/lib/api/keys.ts';
import { useTemplateDetail } from '../api.ts';
import { identityDefaults } from './identity-defaults.ts';
import { StepAccess } from './StepAccess.tsx';
import { StepIdentity } from './StepIdentity.tsx';
import { StepName } from './StepName.tsx';
import { STEP_HINT, STEP_LABEL, StepRail } from './StepRail.tsx';
import { StepSignIn } from './StepSignIn.tsx';
import { StepSites } from './StepSites.tsx';
import { useWizard } from './use-wizard.ts';
import { WizardFooter } from './WizardFooter.tsx';

/** The machine's time zone (`GET /notifications/report-settings` names the zone BrowserHive runs in). */
function useHostTimeZone(): string | null {
  const api = useApi();
  const settings = useQuery({
    queryKey: keys.notifications.reportSettings(),
    queryFn: () => api.getReportSettings(),
    staleTime: 5 * 60_000,
  });
  return settings.data?.host_time_zone ?? null;
}

/** `/templates/new`. */
export function NewTemplatePage() {
  const w = useWizard();
  const vaultEnabled = useVaultEnabled() === true;
  const hostZone = useHostTimeZone();
  const existing = useTemplateDetail(w.templateId);
  const created = existing.data?.template;
  const defaults = useMemo(
    () =>
      identityDefaults(
        w.system,
        hostZone,
        typeof navigator === 'undefined' ? 'en-US' : navigator.language,
      ),
    [w.system, hostZone],
  );
  const { step, draft, setDraft, errors } = w;
  const body = (() => {
    switch (step) {
      case 1:
        return <StepName draft={draft} onDraft={setDraft} errors={errors} />;
      case 2:
        return <StepSites draft={draft} onDraft={setDraft} errors={errors} />;
      case 3:
        return (
          <StepIdentity draft={draft} onDraft={setDraft} errors={errors} defaults={defaults} />
        );
      case 4:
        return (
          <StepAccess
            draft={draft}
            onDraft={setDraft}
            errors={errors}
            authMode={w.system?.auth_mode ?? null}
            vaultEnabled={vaultEnabled}
          />
        );
      case 5:
        return w.templateId === undefined ? null : (
          <StepSignIn templateId={w.templateId} again={w.search.again === 1} onAgain={w.setAgain} />
        );
    }
  })();
  const title =
    created === undefined
      ? 'New template'
      : created.status === 'ready'
        ? created.display_name
        : `Set up ${created.display_name}`;
  usePageCrumb(created === undefined ? null : title);
  const stepLabel =
    step === 5 && created?.status === 'ready' && w.search.again !== 1 ? 'Ready' : STEP_LABEL[step];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        description="Sign in to your sites once; agents launch already signed-in sessions from it."
        learnMoreDocs="templatesSignIn"
        learnMore="The template’s browser runs on the machine running BrowserHive. You sign in there by hand; agents get their own windows of that browser and never see passwords or cookie values."
      />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[15rem_minmax(0,60rem)]">
        <StepRail
          step={step}
          reachable={w.reachable}
          done={(s) => w.done(s) && (s < 5 || created?.status === 'ready')}
          onStep={(s) => w.goTo(s)}
        />
        <section
          aria-labelledby="wizard-step-title"
          className="flex min-w-0 flex-col rounded-xl border bg-card shadow-xs dark:shadow-none"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-4">
            <h2
              id="wizard-step-title"
              ref={w.headingRef}
              tabIndex={-1}
              className="text-md font-semibold outline-none"
            >
              {stepLabel}
            </h2>
            {step < 5 ? (
              <span className="text-sm text-muted-foreground lg:hidden">{STEP_HINT[step]}</span>
            ) : null}
            {step < 5 && draft.name !== '' ? (
              <span className="ml-auto truncate font-mono text-sm text-muted-foreground">
                {draft.name}
              </span>
            ) : null}
          </div>
          <div className="p-5">{body}</div>
          {w.failure !== null && step === 4 ? (
            <div className="px-5 pb-4">
              <Callout tone="danger" title="The template wasn’t created">
                {w.failure}
              </Callout>
            </div>
          ) : null}
          {step < 5 ? (
            <WizardFooter
              step={step}
              busy={w.creating}
              nextRef={w.nextRef}
              onBack={() => w.goTo((step - 1) as 1 | 2 | 3 | 4)}
              onSkip={w.skip}
              onNext={w.next}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
