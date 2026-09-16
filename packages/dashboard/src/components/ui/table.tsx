/** @module components/ui/table — shadcn (base-nova) copy; no scroll wrapper (a sticky header sticks to the page scroller), cells wrap by default, row dividers only */
import type * as React from 'react';
import { cn } from '@/lib/utils.ts';

/**
 * Bare `<table>`. It adds no `overflow-x-auto` wrapper on purpose: an overflow container would
 * capture the sticky header. Put the table in a surface that decides how to handle width.
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <table
      data-slot="table"
      className={cn('w-full caption-bottom border-separate border-spacing-0 text-base', className)}
      {...props}
    />
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn(className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&>tr:last-child>td]:border-b-0', className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('bg-muted/50 font-medium [&>tr>td]:border-t', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('transition-colors data-[state=selected]:bg-accent-bg/60', className)}
      {...props}
    />
  );
}

/** Header cell: 40px, 13px muted medium, never wraps. */
function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 border-b px-3 text-left align-middle text-sm font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4 [&:has([role=checkbox])]:w-10 [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Body cell. Content wraps by default; opt into one line with `truncate`/`whitespace-nowrap`
 * plus a `max-w-*` on the cell (or `min-w-0` on an inner flex child).
 */
function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'border-b px-3 py-2 align-middle first:pl-4 last:pr-4 [overflow-wrap:anywhere] [&:has([role=checkbox])]:w-10 [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
