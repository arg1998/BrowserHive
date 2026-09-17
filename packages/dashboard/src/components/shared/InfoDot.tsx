/** @module components/shared/InfoDot — "Learn more" explainer: a small info icon button that opens a popover with an optional title, flowing prose (inline code stays inline) and a "Read the docs" link to browserhive.ai */
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { ICONS } from '@/lib/icons.ts';
import { type DocsPage, docsUrl } from '@/lib/links.ts';
import { cn } from '@/lib/utils.ts';

/** Where "Read the docs" goes: a known docs page, or any URL with its own link text. */
export type InfoDocs = DocsPage | { readonly href: string; readonly label?: string };

/** Props. */
export interface InfoDotProps {
  /** Accessible name of the trigger (`About open attention`). */
  readonly label: string;
  /** Bold first line of the popover. */
  readonly title?: string;
  /** Explainer body: plain text or inline JSX (`<code>`, `<b>`); wrap separate paragraphs in `<p>`. */
  readonly children: ReactNode;
  /** Adds a "Read the docs" link to the website. */
  readonly docs?: InfoDocs;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  readonly align?: 'start' | 'center' | 'end';
  readonly className?: string;
}

/** Info popover. */
export function InfoDot({
  label,
  title,
  children,
  docs,
  side = 'bottom',
  align = 'center',
  className,
}: InfoDotProps) {
  const Icon = ICONS.info;
  const External = ICONS.external;
  const link =
    docs === undefined
      ? undefined
      : typeof docs === 'string'
        ? { href: docsUrl(docs), label: 'Read the docs' }
        : { href: docs.href, label: docs.label ?? 'Read the docs' };
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            // A 40px touch target without growing the line it sits in.
            className={cn(
              'size-6 shrink-0 rounded-full text-subtle-foreground after:absolute after:-inset-2 after:rounded-full hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground pointer-coarse:size-6',
              className,
            )}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <Icon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0 text-popover-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-1.5 px-4 pt-3.5 pb-4">
          {title !== undefined ? (
            <p className="text-sm font-semibold text-foreground">{title}</p>
          ) : null}
          <div
            data-slot="info-body"
            className={cn(
              // A block of flowing text: inline elements stay inline, paragraphs get a gap.
              'block text-sm leading-[1.55] text-muted-foreground [overflow-wrap:anywhere]',
              '[&>p+p]:mt-2 [&_b]:font-semibold [&_b]:text-foreground [&_strong]:font-semibold [&_strong]:text-foreground',
              '[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.8125rem] [&_code]:text-foreground dark:[&_code]:bg-white/[0.08]',
              '[&_ul]:mt-1.5 [&_ul]:flex [&_ul]:list-none [&_ul]:flex-col [&_ul]:gap-1 [&_ul]:p-0',
            )}
          >
            {children}
          </div>
        </div>
        {link !== undefined ? (
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="group/docs flex items-center justify-between gap-2 rounded-b-xl border-t px-4 py-2.5 text-sm font-medium text-accent-text transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
          >
            {link.label}
            <External
              aria-hidden="true"
              className="size-3.5 transition-transform duration-(--duration-fast) group-hover/docs:translate-x-0.5 group-hover/docs:-translate-y-0.5"
            />
          </a>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
