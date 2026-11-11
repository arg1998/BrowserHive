/** @module features/templates/fields — form pieces shared by the wizard and the template page: a labelled field with help and error lines, a switch row with its explanation, and a list of principal subjects typed one at a time (with the agent tokens' principals suggested) */
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** A labelled field with help text, or its error in its place. */
export function Field({
  label,
  htmlFor,
  help,
  error,
  optional,
  children,
  className,
}: {
  readonly label: ReactNode;
  readonly htmlFor?: string;
  readonly help?: ReactNode;
  readonly error?: string | null | undefined;
  readonly optional?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const hasError = error !== null && error !== undefined && error !== '';
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="flex items-center gap-2 text-base font-medium">
        {label}
        {optional === true ? (
          <span className="text-xs font-normal text-muted-foreground">optional</span>
        ) : null}
      </label>
      {children}
      {hasError ? (
        <p className="text-sm text-danger-text" role="alert">
          {error}
        </p>
      ) : help !== undefined ? (
        <div className="text-sm text-pretty text-muted-foreground">{help}</div>
      ) : null}
    </div>
  );
}

/** A switch with its label and what it does; the whole row toggles. */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  tone,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  /** `warn` tints the description while the switch is on (a risky setting). */
  readonly tone?: 'warn';
}) {
  const id = useId();
  const descId = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-base font-medium">
          {label}
        </label>
        {description !== undefined ? (
          <div
            id={descId}
            className={cn(
              'text-sm text-pretty',
              tone === 'warn' && checked ? 'text-warn-text' : 'text-muted-foreground',
            )}
          >
            {description}
          </div>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled ?? false}
        onCheckedChange={(next) => onChange(next)}
        className="mt-0.5"
        {...(description !== undefined && { 'aria-describedby': descId })}
      />
    </div>
  );
}

/** Principal subjects, typed one at a time; known agent principals are offered as suggestions. */
export function PrincipalsInput({
  value,
  onChange,
  suggestions = [],
  label,
  error,
  disabled,
}: {
  readonly value: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly suggestions?: readonly string[];
  readonly label: string;
  readonly error?: string | null | undefined;
  readonly disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const inputId = useId();
  const X = ICONS.close;
  const Plus = ICONS.plus;
  const add = (raw: string) => {
    const subject = raw.trim();
    if (subject.length === 0 || value.includes(subject)) return;
    onChange([...value, subject]);
    setText('');
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add(text);
    }
  };
  const offered = suggestions.filter((s) => !value.includes(s)).slice(0, 8);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {value.length > 0 ? (
        <ul aria-label={label} className="flex flex-wrap gap-1.5">
          {value.map((subject) => (
            <li
              key={subject}
              className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-accent-border bg-accent-bg pr-1 pl-2.5 font-mono text-sm text-accent-text"
            >
              <span className="truncate">{subject}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${subject}`}
                onClick={() => onChange(value.filter((s) => s !== subject))}
                className="focus-ring flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-accent-bg-hover pointer-coarse:size-8"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex max-w-md items-center gap-2">
        <Input
          id={inputId}
          value={text}
          disabled={disabled}
          aria-label={`Add to ${label.toLowerCase()}`}
          aria-invalid={error !== null && error !== undefined ? true : undefined}
          placeholder="Principal, like agent:research"
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled === true || text.trim().length === 0}
          onClick={() => add(text)}
        >
          <Plus aria-hidden="true" />
          Add
        </Button>
      </div>
      {offered.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm text-muted-foreground">Agent tokens:</span>
          {offered.map((subject) => (
            <button
              key={subject}
              type="button"
              disabled={disabled}
              aria-label={`Add ${subject}`}
              onClick={() => add(subject)}
              className="focus-ring inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 font-mono text-sm text-muted-foreground hover:border-ring hover:bg-accent hover:text-foreground pointer-coarse:h-10"
            >
              <Plus aria-hidden="true" className="size-3.5" />
              {subject}
            </button>
          ))}
        </div>
      ) : null}
      {error !== null && error !== undefined ? (
        <p className="text-sm text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
