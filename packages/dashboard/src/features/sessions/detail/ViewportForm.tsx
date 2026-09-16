/** @module features/sessions/detail/ViewportForm — "Resize the agent's browser" (`set_viewport`): a preset (My monitor first) or a custom width × height with inline validation; says plainly that it changes the agent's real viewport and is not attention-gated */
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { resolutionOptions, validateViewport } from './viewport.ts';

/** Props. */
export interface ViewportFormProps {
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onSubmit: (size: { readonly width: number; readonly height: number }) => void;
  readonly screen?: { readonly width: number; readonly height: number } | undefined;
  /** Popover layout: title row and tighter spacing. */
  readonly compact?: boolean;
  readonly className?: string;
}

/** Viewport form. */
export function ViewportForm({
  disabled = false,
  busy = false,
  onSubmit,
  screen,
  compact = false,
  className,
}: ViewportFormProps) {
  const id = useId();
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [errors, setErrors] = useState<{ width?: string; height?: string }>({});
  const options = resolutionOptions(screen);
  const Warn = ICONS.warn;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateViewport(width, height);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSubmit(result.value);
  };
  const error = errors.width ?? errors.height;
  return (
    <form
      className={cn('flex flex-col', compact ? 'gap-3' : 'gap-4', className)}
      onSubmit={submit}
      noValidate
      aria-label="Resize agent browser"
    >
      {compact ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-base font-semibold">Resize the agent's browser</p>
          <p className="text-sm text-muted-foreground">Pages may re-layout under the agent.</p>
        </div>
      ) : null}
      <p className="flex items-start gap-2 text-sm text-warn-text">
        <Warn aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-medium">Changes the agent's real viewport</span>
          {compact ? null : (
            <span className="text-muted-foreground">
              {' '}
              — not gated on an attention request. The next frame shows the new size.
            </span>
          )}
        </span>
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-preset`} className="text-sm font-medium">
          Preset
        </label>
        <SimpleSelect
          id={`${id}-preset`}
          value={null}
          placeholder="Choose a size…"
          disabled={disabled || busy}
          className="w-full"
          options={options.map((o) => ({ value: `${o.width}x${o.height}`, label: o.label }))}
          onValueChange={(value) => {
            const opt = options.find((o) => `${o.width}x${o.height}` === value);
            if (opt !== undefined) onSubmit({ width: opt.width, height: opt.height });
          }}
        />
      </div>
      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">Custom size</legend>
        <div className="flex min-w-0 items-center gap-2">
          {(['width', 'height'] as const).map((field, index) => (
            <span key={field} className="contents">
              {index === 1 ? (
                <span aria-hidden="true" className="text-muted-foreground">
                  ×
                </span>
              ) : null}
              <label htmlFor={`${id}-${field}`} className="sr-only">
                {field}
              </label>
              <Input
                id={`${id}-${field}`}
                inputMode="numeric"
                placeholder={field === 'width' ? 'Width' : 'Height'}
                className={cn('tabular-nums', compact ? 'w-auto min-w-0 flex-1' : 'w-24')}
                value={field === 'width' ? width : height}
                aria-invalid={errors[field] !== undefined}
                aria-describedby={errors[field] !== undefined ? `${id}-error` : undefined}
                disabled={disabled || busy}
                onChange={(e) =>
                  field === 'width' ? setWidth(e.target.value) : setHeight(e.target.value)
                }
              />
            </span>
          ))}
          <Button
            type="submit"
            variant="outline"
            className={cn('shrink-0', !compact && 'ml-auto')}
            disabled={disabled || busy}
          >
            Resize
          </Button>
        </div>
        {error !== undefined ? (
          <p id={`${id}-error`} role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}
