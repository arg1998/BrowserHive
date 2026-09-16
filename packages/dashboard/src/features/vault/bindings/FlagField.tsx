/** @module features/vault/bindings/FlagField — a flag row (ui Checkbox bound through react-hook-form `Controller`, mono flag name, hint; the whole row is the label) and a labelled field row with hint and inline error */
import { type ReactNode, useId } from 'react';
import { type Control, Controller, type FieldPath, type FieldValues } from 'react-hook-form';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { cn } from '@/lib/utils.ts';

/** Flag row for a boolean form field. */
export function FlagField<T extends FieldValues>({
  control,
  name,
  hint,
  className,
}: {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly hint: string;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div
          className={cn(
            '-mx-3 flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent',
            className,
          )}
        >
          <Checkbox
            id={id}
            name={field.name}
            checked={field.value === true}
            onCheckedChange={(checked) => field.onChange(checked === true)}
            onBlur={field.onBlur}
            inputRef={field.ref}
            aria-describedby={`${id}-hint`}
            className="mt-0.5"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={id} className="font-mono text-sm [overflow-wrap:anywhere]">
              {name}
            </label>
            <span id={`${id}-hint`} className="text-sm text-muted-foreground">
              {hint}
            </span>
          </div>
        </div>
      )}
    />
  );
}

/** Labelled control with hint and `role=alert` error; `children(id, describedBy)` renders the control. */
export function FormRow({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly children: (id: string, describedBy: string | undefined, invalid: boolean) => ReactNode;
}) {
  const id = useId();
  const hintId = hint !== undefined ? `${id}-hint` : '';
  const errorId = error !== undefined ? `${id}-error` : '';
  const describedBy = [hintId, errorId].filter((s) => s !== '').join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id, describedBy, error !== undefined)}
      {hint !== undefined ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
