/** @module features/templates/wizard/WizardFooter — Cancel on every step (it discards the draft, asking first when there is one), Back from step 2 on, Skip to sign-in on step 3, and Next / Create and sign in (both wait while the site catalog loads) */
import type { Ref } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import type { WizardStep } from '../search.ts';

/** Footer of steps 1–4. */
export function WizardFooter({
  step,
  busy,
  nextRef,
  onBack,
  onCancel,
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
  /** Leave the wizard and forget the draft. */
  readonly onCancel: () => void;
  readonly onSkip: () => void;
  readonly onNext: () => void;
}) {
  const ArrowLeft = ICONS.arrowLeft;
  const ArrowRight = ICONS.arrowRight;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-surface-inset px-5 py-3">
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
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
        {step > 1 ? (
          <Button type="button" variant="outline" disabled={busy} onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            Back
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
