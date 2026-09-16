/** @module components/shared/KeyValue — definition list for metadata: muted 13px keys, 14px values, optional row dividers and two columns */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils.ts';
import { Breakable } from './breakable.tsx';

/** One row. */
export interface KeyValueItem {
  readonly key: string;
  readonly value: ReactNode;
  readonly mono?: boolean;
}

/** Props. */
export interface KeyValueProps {
  readonly items: readonly KeyValueItem[];
  readonly className?: string;
  /** `2` puts pairs side by side from the `@2xl` container width. */
  readonly columns?: 1 | 2;
  /** Hairline between rows (settings-style lists). */
  readonly dividers?: boolean;
}

/** Definition list. String values wrap at token boundaries (paths, URLs, user agents); mono values are 13px. */
export function KeyValue({ items, className, columns = 1, dividers = false }: KeyValueProps) {
  return (
    <div className={cn('@container', className)}>
      <dl
        className={cn(
          'grid gap-x-8',
          columns === 2 ? 'grid-cols-1 @2xl:grid-cols-2' : 'grid-cols-1',
          !dividers && 'gap-y-2.5',
        )}
      >
        {items.map((item) => (
          <div
            key={item.key}
            className={cn(
              'grid min-w-0 grid-cols-[minmax(7rem,38%)_1fr] items-baseline gap-4',
              dividers && 'border-b py-2.5 last:border-b-0',
            )}
          >
            <dt className="truncate text-sm text-muted-foreground">{item.key}</dt>
            <dd
              className={cn(
                // Wrap long tokens at / . - boundaries first; break inside a segment only as a fallback.
                'min-w-0 text-base [overflow-wrap:break-word]',
                item.mono === true && 'font-mono text-sm',
              )}
            >
              <Breakable>{item.value}</Breakable>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
