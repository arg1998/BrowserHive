/** @module features/templates/wizard/use-wizard — the wizard's state (spec 13 §7.1): the step from the URL only (`?step=`, `?template=`, `?again=`; no `?step` is step 1, whatever the draft holds), the draft kept in this tab, Cancel (asks before discarding a draft with content, then forgets it and goes to the list), per-step problems shown once Next was tried plus the server's field issues, focus on the step heading (on Next for steps 3 and 4), deep links past an unfinished step (or to step 5 without a template) sent back, and creating the template on leaving step 4, once the site catalog has loaded, with the pack hash of every site a pack covers */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useSitePackCatalog } from '@/features/site-packs/api.ts';
import { packNote } from '@/features/site-packs/model.ts';
import { useSystem } from '@/features/system/api.ts';
import { isAppError, toAppError } from '@/lib/api/errors.ts';
import { useCreateTemplate } from '../api.ts';
import { discardDraftConfirm } from '../confirm-copy.ts';
import type { WizardSearch, WizardStep } from '../search.ts';
import {
  clearDraft,
  type DraftProblem,
  draftHasContent,
  EMPTY_DRAFT,
  firstProblemStep,
  issuesOf,
  markCreatedHere,
  readDraft,
  stepOfIssue,
  stepProblems,
  type TemplateDraft,
  toTemplateInput,
  writeDraft,
} from './draft.ts';
import { identityDefaults } from './identity-defaults.ts';
import { needProblems } from './site-needs.ts';
import { useSiteNeeds } from './use-site-needs.ts';

/** Server field names → the draft's (`display_name` → `displayName`). */
export function errorMap(problems: readonly DraftProblem[]): Readonly<Record<string, string>> {
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

/** The step a URL lands on: the template's sign-in, or the requested step. */
export function stepOf(search: WizardSearch): WizardStep {
  return search.template !== undefined ? 5 : (search.step ?? 1);
}

/** Wizard state and actions. */
export function useWizard() {
  const search = useSearch({ strict: false }) as WizardSearch;
  const navigate = useNavigate();
  const confirm = useConfirm();
  const system = useSystem();
  const create = useCreateTemplate();
  const catalog = useSitePackCatalog();
  // Create waits for the catalog: every site a pack covers is sent with the hash its card shows
  // (review S-M4; the server refuses a pack site without one).
  const catalogLoading = catalog.isPending;
  const catalogPacks = catalog.data?.status.enabled === true ? catalog.data.data : [];
  const authToken = system.data?.auth_mode === 'token';
  const templateId = search.template;
  const step = stepOf(search);
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
  const goTo = useCallback(
    (next: WizardStep, extra: Partial<WizardSearch> = {}, replace = false) =>
      void navigate({ to: '.', search: { step: next, ...extra }, replace }),
    [navigate],
  );
  const setAgain = useCallback(
    (on: boolean) =>
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, again: on ? 1 : undefined }),
        replace: true,
      }),
    [navigate],
  );

  // Focus follows the step (spec 13 §7.1); the first render keeps the page's own focus.
  useEffect(() => {
    if (lastStep.current === step) return;
    lastStep.current = step;
    if ((step === 3 || step === 4) && nextRef.current !== null) nextRef.current.focus();
    else headingRef.current?.focus();
  }, [step]);

  // A deep link past an unfinished step lands on that step; step 5 needs a template.
  const blocked = templateId === undefined ? firstProblemStep(draft, authToken) : null;
  useEffect(() => {
    if (templateId !== undefined || system.data === undefined) return;
    if (blocked !== null && step > blocked) goTo(blocked, {}, true);
    else if (step === 5) goTo(4, {}, true);
  }, [blocked, step, templateId, goTo, system.data]);

  // A chosen site's pack needs (stealth floor, fingerprint, headed): step 3 explains before a refusal.
  const needs = useSiteNeeds(draft.sites, catalogPacks);
  const defaults = identityDefaults(system.data, null, '');
  const settings = {
    stealth: draft.stealth ?? defaults.stealth,
    fingerprint: draft.fingerprint ?? defaults.fingerprint,
    headless: draft.headless,
  };
  const problemsAt = (s: WizardStep) => [
    ...stepProblems(draft, s, authToken),
    ...(s === 3 ? needProblems(needs, settings) : []),
  ];
  const problems = step === 5 ? [] : problemsAt(step);
  const errors = errorMap([
    ...(tried.has(step) ? problems : []),
    ...serverProblems.filter((p) => stepOfIssue(p.field) === step),
  ]);

  const submit = async () => {
    setFailure(null);
    if (catalogLoading) return;
    const catalogShas = Object.fromEntries(
      draft.sites.flatMap((site) => {
        const note = packNote(catalogPacks, site);
        return note === null ? [] : [[site, note.sha256] as const];
      }),
    );
    try {
      const { template } = await create.mutateAsync(toTemplateInput(draft, catalogShas));
      // The saved draft goes; the URL now names the template, so the earlier steps no longer show.
      clearDraft();
      markCreatedHere(template.template_id);
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
    const blockedAt = ([1, 2, 3, 4] as const).find((x) => problemsAt(x).length > 0) ?? null;
    if (blockedAt !== null) {
      setTried((t) => new Set([...t, blockedAt]));
      goTo(blockedAt);
      return;
    }
    void submit();
  };
  /** Leave the wizard; a draft with content is discarded only after the operator says so. */
  const cancel = async () => {
    if (draftHasContent(draft) && !(await confirm(discardDraftConfirm()))) return;
    clearDraft();
    void navigate({ to: '/templates' });
  };
  const reachable = (s: WizardStep) =>
    templateId === undefined &&
    s < 5 &&
    ([1, 2, 3, 4] as const).filter((x) => x < s).every((x) => problemsAt(x).length === 0);
  const done = (s: WizardStep) => templateId !== undefined || problemsAt(s).length === 0;

  return {
    search,
    step,
    templateId,
    draft,
    setDraft,
    errors,
    failure,
    creating: create.isPending,
    catalogLoading,
    system: system.data,
    needs,
    settings,
    headingRef,
    nextRef,
    goTo,
    setAgain,
    next,
    skip,
    cancel,
    reachable,
    done,
  };
}
