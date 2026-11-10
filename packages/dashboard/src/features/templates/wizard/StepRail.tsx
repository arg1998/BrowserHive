/** @module features/templates/wizard/StepRail — the wizard's step rail (spec 13 §7.1): vertical with each step's hint from 1024px, a "Step n of 5" line with a progress bar below; finished steps show a check, steps after a problem cannot be opened, and nothing before Sign in can be reopened once the template exists */
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { WIZARD_STEPS, type WizardStep } from '../search.ts';

/** Step titles. */
export const STEP_LABEL: { readonly [S in WizardStep]: string } = {
  1: 'Name',
  2: 'Sites',
  3: 'Identity and network',
  4: 'Access',
  5: 'Sign in',
};

/** One line under the current step. */
export const STEP_HINT: { readonly [S in WizardStep]: string } = {
  1: 'What agents call it.',
  2: 'The sites this account signs in to.',
  3: 'The browser, fingerprint and network sites will see.',
  4: 'Which agents may use it, and what stays protected.',
  5: 'Sign in by hand in a window on the BrowserHive machine.',
};

/** Rail. */
export function StepRail({
  step,
  reachable,
  done,
  onStep,
}: {
  readonly step: WizardStep;
  readonly reachable: (s: WizardStep) => boolean;
  readonly done: (s: WizardStep) => boolean;
  readonly onStep: (s: WizardStep) => void;
}) {
  const Check = ICONS.check;
  return (
    <nav aria-label="Template setup steps" className="min-w-0">
      <p className="mb-3 text-sm text-muted-foreground lg:hidden">
        Step {step} of {WIZARD_STEPS.length} ·{' '}
        <span className="text-foreground">{STEP_LABEL[step]}</span>
      </p>
      <div className="mb-1 flex gap-1 lg:hidden" aria-hidden="true">
        {WIZARD_STEPS.map((s) => (
          <span
            key={s}
            className={cn('h-1 flex-1 rounded-full', s <= step ? 'bg-primary' : 'bg-border-strong')}
          />
        ))}
      </div>
      <ol className="hidden flex-col gap-1 lg:flex">
        {WIZARD_STEPS.map((s) => {
          const current = s === step;
          const complete = done(s) && s < step;
          const enabled = reachable(s) && !current;
          return (
            <li key={s}>
              <button
                type="button"
                disabled={!enabled}
                aria-current={current ? 'step' : undefined}
                onClick={() => onStep(s)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-ring disabled:cursor-default',
                  current ? 'bg-accent-bg/70 dark:bg-accent-bg' : enabled && 'hover:bg-accent',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
                    current && 'border-primary bg-primary text-primary-foreground',
                    complete && 'border-success-border bg-success-bg text-success-text',
                    !current && !complete && 'text-muted-foreground',
                  )}
                >
                  {complete ? <Check aria-hidden="true" className="size-3.5" /> : s}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      'text-sm font-medium',
                      !enabled && !current && !complete && 'text-muted-foreground',
                    )}
                  >
                    {STEP_LABEL[s]}
                  </span>
                  {current ? (
                    <span className="text-xs text-muted-foreground">{STEP_HINT[s]}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
