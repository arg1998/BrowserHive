/** @module features/notifications/channels/wizard/StepPlatform — step 1: choose the platform (radio cards with setup time and what each supports; the upcoming platforms shown disabled) and, for Discord, the mode (webhook now, bot with act buttons later) with "What's the difference?" */
import {
  AVAILABLE_DISCORD_MODES,
  type AvailableChannelKind,
} from '@browserhive/contracts/notifications';
import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import type { ChannelDraft } from '../model.ts';
import { PLATFORMS, PlatformMark, UPCOMING_PLATFORMS } from '../platforms.tsx';
import { DiscordDifference } from './DiscordDifference.tsx';

/** A radio card (native radio inside, so arrow keys and forms behave). */
export function RadioCard({
  name,
  value,
  checked,
  disabled,
  onChange,
  children,
  className,
}: {
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <label
      className={cn(
        'relative flex min-w-0 cursor-pointer gap-3 rounded-xl border bg-card p-4 transition-[border-color,box-shadow,background-color] duration-(--duration-fast)',
        'hover:border-border-strong has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring',
        checked &&
          'border-accent-border bg-accent-bg/40 shadow-xs ring-1 ring-accent-border hover:border-accent-border dark:bg-accent-bg/30',
        disabled && 'cursor-not-allowed opacity-60 hover:border-border',
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-4 right-4 flex size-4 items-center justify-center rounded-full border',
          checked ? 'border-primary bg-primary' : 'border-border-strong bg-card',
        )}
      >
        {checked ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
      </span>
    </label>
  );
}

/** Props. */
export interface StepPlatformProps {
  readonly draft: ChannelDraft;
  readonly onKind: (kind: AvailableChannelKind) => void;
  readonly onMode: (mode: string) => void;
  /** Editing an existing channel: the platform is fixed. */
  readonly locked: boolean;
}

/** Step 1. */
export function StepPlatform({ draft, onKind, onMode, locked }: StepPlatformProps) {
  const [difference, setDifference] = useState(false);
  const Help = ICONS.help;
  const Clock = ICONS.clock;
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-base font-medium">Where should notifications go?</legend>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {PLATFORMS.map((p) => (
            <RadioCard
              key={p.kind}
              name="platform"
              value={p.kind}
              checked={draft.kind === p.kind}
              disabled={locked && draft.kind !== p.kind}
              onChange={() => onKind(p.kind)}
            >
              <PlatformMark kind={p.kind} size="lg" />
              <span className="flex min-w-0 flex-1 flex-col gap-1 pr-6">
                <span className="text-md font-semibold">{p.label}</span>
                <span className="text-sm text-muted-foreground">{p.tagline}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock aria-hidden="true" className="size-3" />
                    {p.setup}
                  </span>
                  {p.facts.map((f) => (
                    <span
                      key={f}
                      className="rounded-full bg-muted px-2 text-xs leading-5 text-muted-foreground dark:bg-white/[0.06]"
                    >
                      {f}
                    </span>
                  ))}
                </span>
              </span>
            </RadioCard>
          ))}
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>Coming later:</span>
          {UPCOMING_PLATFORMS.map((u) => (
            <span
              key={u.label}
              className="rounded-full border border-dashed px-2 text-xs leading-5"
              title={u.note}
            >
              {u.label}
            </span>
          ))}
        </p>
      </fieldset>

      {draft.kind === 'discord' ? (
        <div
          role="radiogroup"
          aria-labelledby="discord-mode-label"
          className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-4 dark:bg-white/[0.02]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="discord-mode-label" className="text-base font-medium">
              How should BrowserHive post to Discord?
            </h3>
            <Button type="button" variant="link" size="sm" onClick={() => setDifference(true)}>
              <Help aria-hidden="true" />
              What's the difference?
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <RadioCard
              name="discord-mode"
              value="webhook"
              checked={draft.mode === 'webhook' || draft.mode === null}
              onChange={onMode}
            >
              <span className="flex min-w-0 flex-col gap-1 pr-6">
                <span className="font-semibold">Webhook</span>
                <span className="text-sm text-muted-foreground">
                  30-second setup. Alerts, screenshots, live updates and link buttons.
                </span>
              </span>
            </RadioCard>
            <RadioCard
              name="discord-mode"
              value="bot"
              checked={draft.mode === 'bot'}
              disabled={!AVAILABLE_DISCORD_MODES.includes('bot')}
              onChange={onMode}
            >
              <span className="flex min-w-0 flex-col gap-1 pr-6">
                <span className="flex items-center gap-2 font-semibold">
                  Bot
                  <span className="rounded-full bg-muted px-2 text-xs leading-5 font-normal text-muted-foreground dark:bg-white/[0.06]">
                    coming later
                  </span>
                </span>
                <span className="text-sm text-muted-foreground">
                  Approve or deny right in Discord. Arrives with act buttons.
                </span>
              </span>
            </RadioCard>
          </div>
        </div>
      ) : null}
      <DiscordDifference open={difference} onOpenChange={setDifference} />
    </div>
  );
}
