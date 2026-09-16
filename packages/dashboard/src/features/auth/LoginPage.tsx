/** @module features/auth/LoginPage — sign-in card: 40px password field with show/hide, a clear error (an empty field is reported on submit, the button never looks disabled for it), the document title, the 429 countdown on the button, and a collapsible "where is the password" hint (the API cannot tell a first run apart, so it stays out of the way) (spec 04 §12.12) */
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '@/app/providers/AuthProvider.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { type AppError, toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { AuthLayout } from './AuthLayout.tsx';
import { PasswordInput } from './PasswordInput.tsx';
import { type LoginForm, loginForm } from './schemas.ts';
import { useRetryCountdown } from './use-retry-countdown.ts';

/** Message for a failed login. */
export function loginErrorMessage(error: AppError, secondsLeft: number): string {
  if (error.status === 429) return `Too many attempts. Try again in ${secondsLeft}s.`;
  if (error.status === 401) return 'Invalid password.';
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT')
    return 'The daemon could not be reached.';
  return error.message;
}

/** Login page. */
export function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState<AppError | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const seconds = useRetryCountdown(retryAfter);
  const form = useForm<LoginForm>({
    resolver: zodResolver(loginForm),
    defaultValues: { password: '' },
  });
  const passwordRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => passwordRef.current?.focus(), []);
  const busy = form.formState.isSubmitting;
  const locked = seconds > 0;
  const { ref: fieldRef, ...passwordField } = form.register('password', {
    onChange: () => {
      if (error !== null && error.status !== 429) setError(null);
      if (form.formState.errors.password !== undefined) form.clearErrors('password');
    },
  });
  const Alert = ICONS.error;
  // Submit stays enabled; an empty password is reported on submit, next to the field.
  const emptyError = form.formState.errors.password !== undefined && error === null;
  const Chevron = ICONS.chevronRight;

  const submit = form.handleSubmit(
    async (values) => {
      setError(null);
      try {
        await login(values.password);
      } catch (raw) {
        const err = toAppError(raw);
        setError(err);
        setRetryAfter(err.status === 429 ? (err.retryAfterMs ?? 60_000) : null);
        passwordRef.current?.select();
      }
    },
    () => passwordRef.current?.focus(),
  );

  return (
    <AuthLayout title="Sign in" subtitle="Enter the operator password for this daemon.">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            aria-invalid={error !== null || form.formState.errors.password !== undefined}
            aria-describedby={error !== null || emptyError ? 'login-error' : undefined}
            {...passwordField}
            ref={(el) => {
              fieldRef(el);
              passwordRef.current = el;
            }}
          />
          {error !== null || emptyError ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-danger-text">
              <Alert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span id="login-error">
                {error !== null ? loginErrorMessage(error, seconds) : 'Enter the password.'}
              </span>
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={busy || locked}>
          {busy ? <Spinner /> : null}
          {busy ? 'Signing in…' : locked ? `Wait ${seconds}s` : 'Sign in'}
        </Button>
        <details className="group rounded-lg text-sm text-muted-foreground">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <Chevron
              aria-hidden="true"
              className="size-4 transition-transform duration-(--duration-fast) group-open:rotate-90"
            />
            Where do I find the password?
          </summary>
          <p className="mt-2 pl-5.5 text-pretty">
            On first start the daemon prints a seed password to its console and saves it to{' '}
            <code className="font-mono text-sm text-foreground">credentials.txt</code> in the data
            directory. You are asked to replace it after signing in.
          </p>
        </details>
      </form>
    </AuthLayout>
  );
}
