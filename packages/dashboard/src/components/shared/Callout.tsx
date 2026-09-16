/** @module components/shared/Callout — toned inline notice (soft tint, icon, title, body, action), optionally dismissible per key in localStorage */
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { readStorage, writeStorage } from '@/lib/storage.ts';
import { cn } from '@/lib/utils.ts';
import { TONE_CLASSES } from './tones.ts';

/** Props. */
export interface CalloutProps {
  readonly tone: Tone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly dismissible?: { readonly key: string };
  readonly className?: string;
  /** Action(s) placed at the right on wide screens, under the text on narrow ones. */
  readonly action?: ReactNode;
}

const DISMISS_PREFIX = 'bh.callout.';

/** Callout. */
export function Callout({ tone, title, children, dismissible, className, action }: CalloutProps) {
  const [dismissed, setDismissed] = useState(
    () => dismissible !== undefined && readStorage(DISMISS_PREFIX + dismissible.key) === '1',
  );
  if (dismissed) return null;
  const Icon =
    tone === 'danger'
      ? ICONS.danger
      : tone === 'warn'
        ? ICONS.warn
        : tone === 'success'
          ? ICONS.success
          : tone === 'vault'
            ? ICONS.vault
            : ICONS.info;
  const Close = ICONS.close;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'note'}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3 text-base',
        TONE_CLASSES[tone].soft,
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {title !== undefined ? <p className="font-semibold">{title}</p> : null}
          {children !== undefined ? (
            <div className="text-sm text-foreground/85 [overflow-wrap:anywhere]">{children}</div>
          ) : null}
        </div>
        {action !== undefined ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>
        ) : null}
      </div>
      {dismissible !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          className="-my-1 -mr-1.5 hover:bg-black/5 dark:hover:bg-white/10"
          onClick={() => {
            writeStorage(DISMISS_PREFIX + dismissible.key, '1');
            setDismissed(true);
          }}
        >
          <Close aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
