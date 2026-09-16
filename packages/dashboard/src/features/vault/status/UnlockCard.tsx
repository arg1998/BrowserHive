/** @module features/vault/status/UnlockCard — generic unlock form from `unlock {required, mode, hint}`: a pasted session token (Bitwarden) or a passphrase (password input, Enter submits, inline error) (spec 04 §12.7, D-14) */
import { UnlockVaultRequest, type VaultUnlockDescriptor } from '@browserhive/contracts/http';
import { zodResolver } from '@hookform/resolvers/zod';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ErrorCode } from '@/components/shared/ErrorState.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useUnlockVault } from '../api.ts';

const unlockForm = z.object({
  secret: z.string().trim().min(1, 'Enter a value to unlock.').max(4096),
});
type UnlockForm = z.infer<typeof unlockForm>;

/** Body for the mode (validated with the contracts schema). A pasted token loses surrounding whitespace. */
export function unlockBody(
  mode: VaultUnlockDescriptor['mode'],
  secret: string,
): UnlockVaultRequest {
  return UnlockVaultRequest.parse(
    mode === 'token' ? { token: secret.trim() } : { passphrase: secret },
  );
}

/** Unlock card. */
export function UnlockCard({ unlock }: { readonly unlock: VaultUnlockDescriptor }) {
  const id = useId();
  const mutation = useUnlockVault();
  const form = useForm<UnlockForm>({
    resolver: zodResolver(unlockForm),
    defaultValues: { secret: '' },
  });
  if (unlock.mode === 'none') return null;
  const token = unlock.mode === 'token';
  const label = token ? 'Session token' : 'Passphrase';
  const fieldError = form.formState.errors.secret?.message;
  const error = mutation.error === null ? null : toAppError(mutation.error);
  const submit = form.handleSubmit((values) =>
    mutation.mutate(unlockBody(unlock.mode, values.secret), {
      onSuccess: () => form.reset({ secret: '' }),
    }),
  );
  const Lock = ICONS.lock;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-xs sm:flex-row sm:gap-4 dark:shadow-none"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warn-bg text-warn-text">
        <Lock aria-hidden="true" className="size-5" />
      </span>
      <form
        className="flex min-w-0 flex-1 flex-col gap-3"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex flex-col gap-0.5">
          <h2 id={`${id}-title`} className="text-md font-semibold">
            Backend locked
          </h2>
          <p className="text-sm text-pretty text-muted-foreground">
            {token
              ? 'Unlock it to list groups and release credential fills. Paste a session token: BrowserHive never asks for your master password, and keeps the token in memory only.'
              : 'Unlock it to list groups and release credential fills. The passphrase goes to the backend and is never stored.'}
          </p>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 sm:max-w-md">
          <label htmlFor={id} className="col-span-2 flex items-center gap-2 text-sm font-medium">
            {label}
            <span className="font-normal text-muted-foreground">
              ({unlock.required ? 'required' : 'optional'})
            </span>
          </label>
          <Input
            id={id}
            type="password"
            autoComplete={token ? 'off' : 'current-password'}
            spellCheck={false}
            className="font-mono"
            aria-invalid={fieldError !== undefined || error !== null}
            aria-describedby={`${id}-msg`}
            {...form.register('secret')}
          />
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Unlocking…' : 'Unlock'}
          </Button>
        </div>
        <div id={`${id}-msg`} className="flex flex-col gap-1 text-sm">
          {unlock.hint !== null ? <p className="text-muted-foreground">{unlock.hint}</p> : null}
          {fieldError !== undefined ? (
            <p role="alert" className="text-danger-text">
              {fieldError}
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-danger-text">
              {error.code === 'VAULT_UNLOCK_FAILED'
                ? token
                  ? 'Unlock failed: the backend rejected this session token. It may have expired; create a new one and paste it again.'
                  : 'Unlock failed: check the passphrase.'
                : error.message}
              <ErrorCode error={error} />
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
