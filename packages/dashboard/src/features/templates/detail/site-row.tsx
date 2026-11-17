/** @module features/templates/detail/site-row — one labelled row of a site card on the Sites tab (label column from 640px, value beside it) */
import type { ReactNode } from 'react';

/** A row. */
export function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 text-base text-pretty">{children}</div>
    </div>
  );
}
