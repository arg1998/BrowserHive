/** @module features/notifications/channels/wizard/fields — form pieces of the channel wizard: a labelled field row, the environment-variable name field with its live set/missing state (never the value), a copyable code block, and the per-launch-method instructions */
import { type ReactNode, useId, useState } from 'react';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { envSnippet, LAUNCH_METHODS, type LaunchMethod } from '../model.ts';

/** A labelled field with help text and an error line. */
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
  readonly optional?: boolean | undefined;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="flex items-center gap-2 text-base font-medium">
        {label}
        {optional === true ? (
          <span className="text-xs font-normal text-muted-foreground">optional</span>
        ) : null}
      </label>
      {children}
      {error !== null && error !== undefined && error !== '' ? (
        <p className="text-sm text-danger-text" role="alert">
          {error}
        </p>
      ) : help !== undefined ? (
        <p className="text-sm text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

/** Whether a variable is set on the server: `true`, `false`, or `null` while unknown. */
export type EnvState = boolean | null;

/** The set / missing pill of one variable. */
export function EnvStatePill({
  state,
  checking,
}: {
  readonly state: EnvState;
  readonly checking: boolean;
}) {
  const Check = ICONS.check;
  const Missing = ICONS.close;
  if (state === null) {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2 text-xs text-muted-foreground dark:bg-white/[0.06]">
        {checking ? <Spinner className="size-3" /> : null}
        checking…
      </span>
    );
  }
  return state ? (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-success-bg px-2 text-xs font-medium text-success-text">
      <Check aria-hidden="true" className="size-3.5" />
      set
    </span>
  ) : (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-danger-bg px-2 text-xs font-medium text-danger-text">
      <Missing aria-hidden="true" className="size-3.5" />
      missing
    </span>
  );
}

/** The name of an environment variable, with its live state on the server. */
export function EnvVarField({
  label,
  help,
  value,
  onChange,
  state,
  checking,
  error,
  optional,
  disabled,
}: {
  readonly label: string;
  readonly help: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly state: EnvState;
  readonly checking: boolean;
  readonly error?: string | null | undefined;
  readonly optional?: boolean | undefined;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} help={help} error={error} optional={optional}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="BH_…"
          aria-invalid={error !== null && error !== undefined ? true : undefined}
          className="max-w-xs font-mono"
          onChange={(event) => onChange(event.target.value.trim())}
        />
        {value !== '' ? <EnvStatePill state={state} checking={checking} /> : null}
      </div>
    </Field>
  );
}

/** A code block with a copy button. */
export function CodeBlock({ code, label }: { readonly code: string; readonly label: string }) {
  return (
    <div
      data-reveal-scope=""
      className="relative min-w-0 rounded-lg border bg-muted/50 dark:bg-black/20"
    >
      <pre className="overflow-x-auto p-3 pr-12 font-mono text-sm leading-relaxed">{code}</pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={code} label={`Copy ${label}`} visibility="always" />
      </div>
    </div>
  );
}

/** Where to put the variables, for each way BrowserHive may be started. */
export function LaunchInstructions({ names }: { readonly names: readonly string[] }) {
  const [method, setMethod] = useState<LaunchMethod>('shell');
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        role="tablist"
        aria-label="How BrowserHive is started"
        className="inline-flex h-9 w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 dark:bg-white/[0.06]"
      >
        {LAUNCH_METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            id={`${id}-${m.id}`}
            aria-selected={method === m.id}
            aria-controls={`${id}-panel`}
            className={cn(
              'h-8 cursor-pointer rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors focus-ring hover:text-foreground',
              method === m.id && 'bg-card text-foreground shadow-sm dark:bg-white/10',
            )}
            onClick={() => setMethod(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${method}`}>
        <CodeBlock code={envSnippet(method, names)} label={`${method} lines`} />
      </div>
    </div>
  );
}

/** A switch with its label (the label is associated by id, so clicking the text toggles it). */
export function SwitchField({
  checked,
  disabled,
  onChange,
  children,
  size,
  className,
  labelClassName,
  reverse = false,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean | undefined;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
  readonly size?: 'sm' | 'default';
  readonly className?: string;
  readonly labelClassName?: string;
  /** Label first, switch at the end (settings rows). */
  readonly reverse?: boolean;
}) {
  const id = useId();
  const control = (
    <Switch
      id={id}
      size={size ?? 'default'}
      checked={checked}
      disabled={disabled ?? false}
      onCheckedChange={(next) => onChange(next)}
    />
  );
  const label = (
    <label
      htmlFor={id}
      className={cn(
        'cursor-pointer select-none',
        disabled === true && 'cursor-not-allowed',
        labelClassName,
      )}
    >
      {children}
    </label>
  );
  return (
    <div className={cn('flex items-center gap-3', reverse && 'justify-between', className)}>
      {reverse ? label : control}
      {reverse ? control : label}
    </div>
  );
}
