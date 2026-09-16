/** @module features/attention/ModeExplainer — explains the two attention modes; the active one is emphasised (both when `mode` is null); shared with the session page */
import type { AttentionMode } from '@browserhive/contracts/enums';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface ModeExplainerProps {
  readonly mode: AttentionMode | null;
}

/** Mode explainer. */
export function ModeExplainer({ mode }: ModeExplainerProps) {
  return (
    <div className="flex flex-col gap-2">
      <p>
        <strong className={cn(mode === 'takeover' ? 'text-muted-foreground' : 'text-foreground')}>
          Notify
        </strong>{' '}
        — the agent paused to flag something and is waiting for your acknowledgement. Resolving lets
        it carry on.
      </p>
      <p>
        <strong className={cn(mode === 'notify' ? 'text-muted-foreground' : 'text-foreground')}>
          Take over
        </strong>{' '}
        — the agent hit something only a human can clear (a CAPTCHA, a 2FA prompt, an ambiguous
        choice). Take over opens the live view with input armed; finish the step, then Resolve.
      </p>
    </div>
  );
}
