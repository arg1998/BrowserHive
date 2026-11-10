/** @module features/templates/wizard/NewTemplatePage — `/templates/new` (spec 13 §7.1, §11.4): the five-step wizard with the step in the URL (`?step=`), a step rail, focus on the step heading on Next and Back (on Next for the pre-filled steps 3 and 4, which offer **Skip to sign-in**), the draft kept on this device until the template exists, `POST /templates` on leaving step 4 (server field errors sent back to their step), then the sign-in step for `?template=` */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { useVaultEnabled } from '@/features/sessions/api.ts';
import { useSystem } from '@/features/system/api.ts';
import { isAppError, toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { ICONS } from '@/lib/icons.ts';
import { useCreateTemplate } from '../api.ts';
import type { WizardSearch, WizardStep } from '../search.ts';
import {
  clearDraft,
  type DraftProblem,
  EMPTY_DRAFT,
  firstProblemStep,
  issuesOf,
  readDraft,
  stepOfIssue,
  stepProblems,
  type TemplateDraft,
  toTemplateInput,
  writeDraft,
} from './draft.ts';
import { StepAccess } from './StepAccess.tsx';
import { identityDefaults, StepIdentity } from './StepIdentity.tsx';
import { StepName } from './StepName.tsx';
import { STEP_HINT, STEP_LABEL, StepRail } from './StepRail.tsx';
import { StepSignIn } from './StepSignIn.tsx';
import { StepSites } from './StepSites.tsx';

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

/** Errors to show, by field: the step's own problems once Next was tried, and the server's. */
function errorMap(problems: readonly DraftProblem[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of problems) {
    const field = p.field
      .replace(/^display_name$/, 'displayName')
      .replace(/^timezone_id$/, 'timezoneId')
      .replace(/^policy\.max_concurrent$/, 'maxConcurrent')
      .replace(/^policy\.authorized_principals.*/, 'principals')
      .replace(/^proxy\.password_env$/, 'proxy.passwordEnv');
    out[field] ??= p.message;
  }
  return out;
}

/** `/templates/new`. */
export function NewTemplatePage() {
  const search = useSearch({ strict: false }) as WizardSearch;
  const navigate = useNavigate();
  const system = useSystem();
  const vaultEnabled = useVaultEnabled() === true;
  const hostZone = useHostTimeZone();
  const create = useCreateTemplate();
  const authToken = system.data?.auth_mode === 'token';
  const templateId = search.template;
  const step: WizardStep = templateId !== undefined ? 5 : (search.step ?? 1);
  const [draft, setDraftState] = useState<TemplateDraft>(() => readDraft() ?? EMPTY_DRAFT);
  const [tried, setTried] = useState<ReadonlySet<WizardStep>>(new Set());
  const [serverProblems, setServerProblems] = useState<readonly DraftProblem[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const lastStep = useRef(step);
  const setDraft = useCallback((update: (d: TemplateDraft) => TemplateDraft) => {
    setDraftState((d) => {
      const next = update(d);
      writeDraft(next);
      return next;
    });
    setServerProblems([]);
  }, []);
  const defaults = useMemo(
    () =>
      identityDefaults(
        system.data,
        hostZone,
        typeof navigator === 'undefined' ? 'en-US' : navigator.language,
      ),
    [system.data, hostZone],
  );

  const goTo = useCallback(
    (next: WizardStep, extra: Partial<WizardSearch> = {}, replace = false) =>
      void navigate({ to: '.', search: { step: next, ...extra }, replace }),
    [navigate],
  );

  // Focus follows the step (spec 13 §7.1); the first render keeps the page's own focus.
  useEffect(() => {
    if (lastStep.current === step) return;
    lastStep.current = step;
    if ((step === 3 || step === 4) && nextRef.current !== null) nextRef.current.focus();
    else headingRef.current?.focus();
  }, [step]);

  // A deep link past an unfinished step lands on that step.
  const blocked = templateId === undefined ? firstProblemStep(draft, authToken) : null;
  useEffect(() => {
    if (templateId === undefined && blocked !== null && step > blocked && system.data !== undefined)
      goTo(blocked, {}, true);
  }, [blocked, step, templateId, goTo, system.data]);

  const problems = step === 5 ? [] : stepProblems(draft, step, authToken);
  const errors = errorMap([
    ...(tried.has(step) ? problems : []),
    ...serverProblems.filter((p) => stepOfIssue(p.field) === step),
  ]);

  const submit = async () => {
    setFailure(null);
    try {
      const { template } = await create.mutateAsync(toTemplateInput(draft));
      // The local draft stays until the page unmounts: the URL now names the template, so the
      // steps before sign-in no longer render, and the next wizard starts from an empty draft.
      clearDraft();
      goTo(5, { template: template.template_id }, true);
    } catch (error) {
      const e = toAppError(error);
      if (e.code === 'TEMPLATE_NAME_TAKEN') {
        setServerProblems([
          { field: 'name', message: `A template is already called ${draft.name}.` },
        ]);
        goTo(1);
        return;
      }
      const issues = isAppError(e) && e.code === 'VALIDATION_FAILED' ? issuesOf(e.details) : [];
      if (issues.length > 0) {
        setServerProblems(issues);
        goTo(stepOfIssue(issues[0]?.field ?? ''));
        return;
      }
      setFailure(e.message);
    }
  };
  const next = () => {
    setTried((t) => new Set([...t, step]));
    if (problems.length > 0) return;
    if (step === 4) void submit();
    else if (step < 4) goTo((step + 1) as WizardStep);
  };
  const skip = () => {
    const blockedAt = firstProblemStep(draft, authToken);
    if (blockedAt !== null) {
      setTried((t) => new Set([...t, blockedAt]));
      goTo(blockedAt);
      return;
    }
    void submit();
  };

  const reachable = (s: WizardStep) =>
    templateId === undefined &&
    s < 5 &&
    ([1, 2, 3, 4] as const)
      .filter((x) => x < s)
      .every((x) => stepProblems(draft, x, authToken).length === 0);
  const done = (s: WizardStep) =>
    templateId !== undefined || stepProblems(draft, s, authToken).length === 0;
  const ArrowLeft = ICONS.arrowLeft;
  const ArrowRight = ICONS.arrowRight;

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
            authMode={system.data?.auth_mode ?? null}
            vaultEnabled={vaultEnabled}
          />
        );
      case 5:
        return templateId === undefined ? null : <StepSignIn templateId={templateId} />;
    }
  })();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New template"
        description="Sign in to your sites once; agents launch already signed-in sessions from it."
        learnMoreDocs="templatesSignIn"
        learnMore="The template’s browser runs on the machine running BrowserHive. You sign in there by hand; agents get their own windows of that browser and never see passwords or cookie values."
      />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <StepRail step={step} reachable={reachable} done={done} onStep={(s) => goTo(s)} />
        <section
          aria-labelledby="wizard-step-title"
          className="flex min-w-0 flex-col rounded-xl border bg-card shadow-xs dark:shadow-none"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-4">
            <h2
              id="wizard-step-title"
              ref={headingRef}
              tabIndex={-1}
              className="text-md font-semibold outline-none"
            >
              {STEP_LABEL[step]}
            </h2>
            <span className="text-sm text-muted-foreground lg:hidden">{STEP_HINT[step]}</span>
            {step < 5 && draft.name !== '' ? (
              <span className="ml-auto truncate font-mono text-sm text-muted-foreground">
                {draft.name}
              </span>
            ) : null}
          </div>
          <div className="p-5">{body}</div>
          {failure !== null && step === 4 ? (
            <div className="px-5 pb-4">
              <Callout tone="danger" title="The template wasn’t created">
                {failure}
              </Callout>
            </div>
          ) : null}
          {step < 5 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-muted/40 px-5 py-3 dark:bg-white/[0.02]">
              {step > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => goTo((step - 1) as WizardStep)}
                >
                  <ArrowLeft aria-hidden="true" />
                  Back
                </Button>
              ) : (
                <Link to="/templates" className={buttonVariants({ variant: 'ghost' })}>
                  Cancel
                </Link>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {step === 3 ? (
                  <Button type="button" variant="link" disabled={create.isPending} onClick={skip}>
                    Skip to sign-in
                  </Button>
                ) : null}
                <Button ref={nextRef} type="button" disabled={create.isPending} onClick={next}>
                  {create.isPending ? <Spinner /> : null}
                  {step === 4 ? 'Create and sign in' : 'Next'}
                  {step < 4 ? <ArrowRight aria-hidden="true" /> : null}
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
