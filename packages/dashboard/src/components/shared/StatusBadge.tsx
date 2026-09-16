/** @module components/shared/StatusBadge — registry-backed state: coloured dot + text by default, tinted pill on request; hints in a tooltip, no string tones */
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import {
  type RegistryDomain,
  type RegistryValue,
  type StatusEntry,
  statusEntry,
} from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { TONE_CLASSES } from './tones.ts';

/** Props. */
export interface StatusBadgeProps<D extends RegistryDomain> {
  readonly domain: D;
  readonly value: RegistryValue<D>;
  /** Override the pulse (live states pulse their dot). */
  readonly pulse?: boolean;
  readonly className?: string;
  /** `dot` (default): dot + text, for state in tables and headers. `pill`: tinted chip. */
  readonly variant?: 'dot' | 'pill';
  /** Pill only: hide the registry icon (a dot is shown instead). */
  readonly iconless?: boolean;
}

/** Registry-backed state indicator. */
export function StatusBadge<D extends RegistryDomain>({
  domain,
  value,
  pulse,
  className,
  variant = 'dot',
  iconless,
}: StatusBadgeProps<D>) {
  const entry = statusEntry(domain, value);
  if (variant === 'dot') {
    return <StatusDot entry={entry} pulse={pulse ?? entry.pulse ?? false} className={className} />;
  }
  return (
    <TonePill
      entry={entry}
      pulse={pulse ?? entry.pulse ?? false}
      className={className}
      iconless={iconless}
    />
  );
}

/** Dot + text for an already-resolved entry. */
export function StatusDot({
  entry,
  pulse = false,
  className,
}: {
  readonly entry: StatusEntry;
  readonly pulse?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const body = (
    <span
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-2 text-base whitespace-nowrap text-foreground',
        className,
      )}
      tabIndex={entry.hint !== undefined ? 0 : undefined}
    >
      <span aria-hidden="true" className="relative flex size-2 shrink-0">
        {pulse ? (
          <span
            className={cn(
              'absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden',
              TONE_CLASSES[entry.tone].dot,
            )}
          />
        ) : null}
        <span className={cn('relative size-2 rounded-full', TONE_CLASSES[entry.tone].dot)} />
      </span>
      <span className="truncate">{entry.label}</span>
    </span>
  );
  return entry.hint !== undefined ? <Hint label={entry.hint}>{body}</Hint> : body;
}

/** Tinted pill for an already-resolved entry. */
export function TonePill({
  entry,
  pulse = false,
  className,
  iconless = false,
}: {
  readonly entry: StatusEntry;
  readonly pulse?: boolean | undefined;
  readonly className?: string | undefined;
  readonly iconless?: boolean | undefined;
}) {
  const Icon = entry.icon !== undefined ? ICONS[entry.icon] : null;
  const body = (
    <span
      className={cn(
        'inline-flex h-5.5 max-w-full items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[entry.tone].soft,
        className,
      )}
      tabIndex={entry.hint !== undefined ? 0 : undefined}
    >
      {Icon !== null && !iconless ? (
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            TONE_CLASSES[entry.tone].dot,
            pulse && 'animate-pulse-soft',
          )}
        />
      )}
      <span className="truncate">{entry.label}</span>
    </span>
  );
  return entry.hint !== undefined ? <Hint label={entry.hint}>{body}</Hint> : body;
}
