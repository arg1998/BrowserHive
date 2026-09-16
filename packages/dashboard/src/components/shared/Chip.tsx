/** @module components/shared/Chip — attribute chips: `Chip`, `CountChip` (hidden at 0 unless asked), `VaultChip` */
import type { ComponentProps } from 'react';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { TONE_CLASSES } from './tones.ts';

/** Tinted chip, 22px, 12px medium text. Use for attributes that need attention, not for repeated defaults. */
export function Chip({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { readonly tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex h-5.5 max-w-full items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone].soft,
        className,
      )}
      {...props}
    />
  );
}

/** `1 error` / `3 errors`: uses `singular` or strips a trailing `s` from `label` when count is 1. */
export function countLabel(count: number, label: string, singular?: string): string {
  if (count !== 1) return label;
  if (singular !== undefined) return singular;
  return label.endsWith('s') ? label.slice(0, -1) : label;
}

/** Count chip (`12 calls`, `2 errors`). Renders nothing at 0 unless `showZero`. */
export function CountChip({
  count,
  label,
  singular,
  tone,
  showZero = false,
  className,
}: {
  readonly count: number;
  readonly label: string;
  readonly singular?: string;
  readonly tone?: Tone;
  readonly showZero?: boolean;
  readonly className?: string;
}) {
  if (count === 0 && !showZero) return null;
  return (
    <Chip
      tone={tone ?? (count > 0 ? 'neutral' : 'muted')}
      className={cn('tabular-nums', className)}
    >
      {formatNumber(count)} {countLabel(count, label, singular)}
    </Chip>
  );
}

/** Vault entry chip (secrets hue). */
export function VaultChip({
  handle,
  className,
}: {
  readonly handle: string;
  readonly className?: string;
}) {
  const Icon = ICONS.vault;
  return (
    <Chip tone="vault" className={cn('font-mono', className)}>
      <Icon aria-hidden="true" className="size-3.5" />
      {handle}
    </Chip>
  );
}
