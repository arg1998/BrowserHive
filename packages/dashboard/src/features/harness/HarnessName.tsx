/** @module features/harness/HarnessName — a harness as the dashboard shows it: the label as text, or a muted "Unknown" chip (never an empty cell), plus the shared self-reported explainer (D-30) */
import { Chip } from '@/components/shared/Chip.tsx';
import { InfoDot } from '@/components/shared/InfoDot.tsx';
import { harnessLabel, isUnknownHarness, SELF_REPORTED_NOTE } from '@/lib/harness.ts';
import { cn } from '@/lib/utils.ts';

/** The harness label; `unknown` renders as a muted chip so it reads as a fact, not a gap. */
export function HarnessName({
  harness,
  className,
}: {
  readonly harness: string | null | undefined;
  readonly className?: string;
}) {
  if (isUnknownHarness(harness)) {
    return (
      <Chip tone="muted" className={cn('font-normal', className)}>
        Unknown
      </Chip>
    );
  }
  return <span className={cn('truncate', className)}>{harnessLabel(harness)}</span>;
}

/** The explainer popover every identity surface carries once. */
export function SelfReportedInfo({ label = 'About client identity' }: { readonly label?: string }) {
  return (
    <InfoDot label={label} title="Self-reported" docs="harnessIdentity">
      <p>{SELF_REPORTED_NOTE}</p>
      <p>
        With nothing configured, BrowserHive recognises many agents on its own; anything else shows
        as Unknown. One header, environment variable or URL parameter names it.
      </p>
    </InfoDot>
  );
}

/** Body text for a `Panel` `info` prop (the panel renders the InfoDot itself). */
export function selfReportedExplainer() {
  return (
    <>
      <p>{SELF_REPORTED_NOTE}</p>
      <p>
        With nothing configured, BrowserHive recognises many agents on its own; anything else shows
        as Unknown. One header, environment variable or URL parameter names it.
      </p>
    </>
  );
}
