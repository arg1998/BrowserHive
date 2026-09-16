/** @module components/shared/brand-mark — the BrowserHive hive mark (hexagon with three honeycomb cells) and the wordmark lockup */
import { useId } from 'react';
import { cn } from '@/lib/utils.ts';

/** Hexagon hive mark; sized by `className` (default 28px). Decorative unless `title` is given. */
export function BrandMark({
  className,
  title,
}: {
  readonly className?: string;
  readonly title?: string;
}) {
  const gradient = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-7 shrink-0', className)}
      role={title === undefined ? undefined : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--brand-from)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-to)' }} />
        </linearGradient>
      </defs>
      <path
        d="M16 3L27.26 9.5L27.26 22.5L16 29L4.74 22.5L4.74 9.5Z"
        fill={`url(#${gradient})`}
        stroke={`url(#${gradient})`}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <g fill="white" transform="translate(0 1.1)">
        <path d="M16 7.71L19.38 9.66L19.38 13.56L16 15.51L12.62 13.56L12.62 9.66Z" />
        <path
          d="M12.2 14.29L15.58 16.24L15.58 20.14L12.2 22.09L8.82 20.14L8.82 16.24Z"
          fillOpacity="0.72"
        />
        <path
          d="M19.8 14.29L23.18 16.24L23.18 20.14L19.8 22.09L16.42 20.14L16.42 16.24Z"
          fillOpacity="0.72"
        />
      </g>
    </svg>
  );
}

/** Mark + "BrowserHive" wordmark. */
export function BrandLockup({ className }: { readonly className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark />
      <span className="text-md font-semibold tracking-tight text-foreground">BrowserHive</span>
    </span>
  );
}
