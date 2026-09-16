/** @module features/overview/components/NewRowsPill — the "N new" pill of a held live list: a zero-height sticky slot at the top of the list (never shifts rows), announcing politely, that shows the held rows and scrolls back up */
import { Button } from '@/components/ui/button.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface NewRowsPillProps {
  /** Held changes (0 hides the pill). */
  readonly count: number;
  /** Of `count`, how many are new rows (the rest are updates that would move up). */
  readonly added: number;
  /** Noun for new rows: `notification` → "3 new notifications". */
  readonly noun: string;
  readonly onShow: () => void;
  /** Gap between the list top (or the stuck position under the topbar) and the pill; tables clear their sticky header row with `mt-12`. */
  readonly offsetClassName?: string;
}

/** Pill label: "3 new navigations", "1 update", "2 new, 1 update". */
export function newRowsLabel(count: number, added: number, noun: string): string {
  const updates = count - added;
  const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;
  if (updates === 0) return `${formatNumber(added)} new ${noun}${added === 1 ? '' : 's'}`;
  if (added === 0) return plural(updates, 'update');
  return `${formatNumber(added)} new, ${plural(updates, 'update')}`;
}

/** "N new" pill. */
export function NewRowsPill({ count, added, noun, onShow, offsetClassName }: NewRowsPillProps) {
  const ArrowUp = ICONS.sortAsc;
  return (
    <div
      className={cn(
        // Zero height and later-painted than the list (z above sticky headers, below the topbar).
        'pointer-events-none sticky top-[calc(var(--topbar-height)+0.5rem)] z-[15] flex h-0 justify-center',
      )}
    >
      <output aria-live="polite" className="contents">
        {count > 0 ? (
          <Button
            type="button"
            size="sm"
            className={cn(
              'pointer-events-auto rounded-full shadow-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1',
              offsetClassName ?? 'mt-2',
            )}
            onClick={onShow}
          >
            <ArrowUp aria-hidden="true" />
            {newRowsLabel(count, added, noun)}
          </Button>
        ) : null}
      </output>
    </div>
  );
}
