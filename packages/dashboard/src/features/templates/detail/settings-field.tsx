/** @module features/templates/detail/settings-field — one labelled row of the Settings tab's panels (label column, control, hint) */
import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label.tsx';

/** A settings row. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start sm:gap-4">
      {htmlFor !== undefined ? (
        <Label htmlFor={htmlFor} className="sm:pt-2">
          {label}
        </Label>
      ) : (
        <span className="text-sm font-medium sm:pt-2">{label}</span>
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        {children}
        {hint !== undefined ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}
