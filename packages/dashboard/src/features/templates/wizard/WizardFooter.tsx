/** @module features/templates/wizard/WizardFooter — Back (or Cancel on step 1), Skip to sign-in on step 3, and Next / Create and sign in (both wait while the site catalog loads) */
import { Link } from '@tanstack/react-router';
import type { Ref } from 'react';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import type { WizardStep } from '../search.ts';

/** Footer of steps 1–4. */
export function WizardFooter({
  step,
  busy,
  nextRef,
  onBack,
  onSkip,
  onNext,
  waitingFor = null,
}: {
  readonly step: WizardStep;
  readonly busy: boolean;
  /** Creating waits for this (the site catalog): Skip to sign-in and Create are off, and it says why. */
  readonly waitingFor?: string | null;
  readonly nextRef: Ref<HTMLButtonElement>;
  readonly onBack: () => void;
  readonly onSkip: () => void;
  readonly onNext: () => void;
}) {
  const ArrowLeft = ICONS.arrowLeft;
  const ArrowRight = ICONS.arrowRight;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-surface-inset px-5 py-3">
      {step > 1 ? (
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
      ) : (
        <Link to="/templates" className={buttonVariants({ variant: 'ghost' })}>
          Cancel
        </Link>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {waitingFor !== null && step >= 3 ? (
          <span role="status" className="text-sm text-muted-foreground">
            {waitingFor}
          </span>
        ) : null}
        {step === 3 ? (
          <Button
            type="button"
            variant="link"
            disabled={busy || waitingFor !== null}
            onClick={onSkip}
          >
            Skip to sign-in
          </Button>
        ) : null}
        <Button
          ref={nextRef}
          type="button"
          disabled={busy || (step === 4 && waitingFor !== null)}
          onClick={onNext}
        >
          {busy ? <Spinner /> : null}
          {step === 4 ? 'Create and sign in' : 'Next'}
          {step < 4 ? <ArrowRight aria-hidden="true" /> : null}
        </Button>
      </div>
    </div>
  );
}
