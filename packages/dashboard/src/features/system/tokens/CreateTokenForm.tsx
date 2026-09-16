/** @module features/system/tokens/CreateTokenForm — name an agent and issue its token: label, then input and button on one line, hint under both; validated by the contracts `CreateTokenRequest.display` rule (1–80 chars, trimmed) */
import { CreateTokenRequest } from '@browserhive/contracts/http';
import { zodResolver } from '@hookform/resolvers/zod';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';

const FormSchema = CreateTokenRequest.pick({ display: true });
type FormInput = z.input<typeof FormSchema>;
type FormOutput = z.output<typeof FormSchema>;

/** Validation message for the name field. */
export const TOKEN_NAME_HINT = 'Enter a name of 1 to 80 characters, e.g. ci-runner.';

/** Props. */
export interface CreateTokenFormProps {
  readonly pending: boolean;
  readonly disabled?: boolean;
  /** Resolves when the request settled; the field clears only after a success. */
  readonly onCreate: (display: string, done: () => void) => void;
}

/** Create token form. */
export function CreateTokenForm({ pending, disabled = false, onCreate }: CreateTokenFormProps) {
  const inputId = useId();
  const errorId = useId();
  const hintId = useId();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(FormSchema),
    defaultValues: { display: '' },
    mode: 'onSubmit',
  });
  const error = form.formState.errors.display;
  const Plus = ICONS.plus;
  return (
    <form
      noValidate
      aria-label="Create agent token"
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 sm:max-w-xl"
      onSubmit={form.handleSubmit((values) =>
        onCreate(values.display, () => form.reset({ display: '' })),
      )}
    >
      <Label htmlFor={inputId} className="col-span-2">
        Agent name
      </Label>
      <Input
        id={inputId}
        autoComplete="off"
        spellCheck={false}
        placeholder="ci-runner"
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? `${errorId} ${hintId}` : hintId}
        {...form.register('display')}
      />
      <Button type="submit" disabled={disabled || pending}>
        {pending ? <Spinner /> : <Plus aria-hidden="true" />}
        Create token
      </Button>
      {error !== undefined ? (
        <p id={errorId} role="alert" className="col-span-2 text-sm text-danger-text">
          {TOKEN_NAME_HINT}
        </p>
      ) : null}
      <p id={hintId} className="col-span-2 text-sm text-muted-foreground">
        The name becomes the principal. An agent only sees the sessions it created.
      </p>
    </form>
  );
}
