/** @module features/system/components/SettingsList — a readable settings list: label (with an optional explainer), value (mono for identifiers, toned when it needs attention), a fix hint under problem values, copy on hover; wraps instead of overflowing at any width, paths between segments */
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { InfoDot } from '@/components/shared/InfoDot.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import type { SettingRow } from '../model.ts';

/** A path with a line-break opportunity after every separator, so it wraps between segments. */
export function PathText({ value }: { readonly value: string }) {
  const parts = value.split(/(?<=[/\\])/);
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: path segments repeat and never reorder
        <span key={index}>
          {part}
          {index < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </>
  );
}

/** Settings list. */
export function SettingsList({
  rows,
  label,
  className,
  short = false,
}: {
  readonly rows: readonly SettingRow[];
  readonly label?: string;
  readonly className?: string;
  /** Short keys and values (runtime versions): stay side by side down to a 16rem container. */
  readonly short?: boolean;
}) {
  const Warn = ICONS.warn;
  return (
    <dl aria-label={label} className={cn('@container flex flex-col', className)}>
      {rows.map((row) => (
        <div
          key={row.label}
          data-reveal-scope=""
          data-tone={row.tone}
          className={cn(
            'grid min-w-0 grid-cols-1 gap-x-6 gap-y-0.5 border-b py-2.5 last:border-b-0',
            short
              ? '@min-[16rem]:grid-cols-[minmax(7rem,40%)_minmax(0,1fr)] @min-[16rem]:items-start'
              : '@md:grid-cols-[minmax(9rem,40%)_minmax(0,1fr)] @md:items-start',
          )}
        >
          <dt className="flex min-h-6 items-center gap-1 text-sm text-muted-foreground">
            <span>{row.label}</span>
            {row.hint !== undefined ? (
              <InfoDot label={`About ${row.label}`}>{row.hint}</InfoDot>
            ) : null}
          </dt>
          <dd className="flex min-w-0 flex-col gap-1">
            <span className="flex min-h-6 min-w-0 items-center gap-1">
              {row.tone === 'warn' || row.tone === 'danger' ? (
                <Warn
                  aria-hidden="true"
                  className={cn('size-4 shrink-0', TONE_CLASSES[row.tone].text)}
                />
              ) : null}
              <span
                className={cn(
                  'min-w-0 [overflow-wrap:anywhere]',
                  row.mono === true ? 'font-mono text-sm' : 'text-base tabular-nums',
                  row.muted === true && 'text-muted-foreground',
                  row.tone !== undefined && row.tone !== 'neutral' && TONE_CLASSES[row.tone].text,
                  (row.tone === 'warn' || row.tone === 'danger') && 'font-medium',
                )}
              >
                {row.path === true ? <PathText value={row.value} /> : row.value}
              </span>
              {row.copy !== undefined ? (
                <CopyButton value={row.copy} label={`Copy ${row.label.toLowerCase()}`} />
              ) : null}
            </span>
            {row.fix !== undefined ? (
              <span className="text-sm text-pretty text-muted-foreground">{row.fix}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
