/** @module features/auth/ChangePasswordPage — current/new/confirm with live requirement checks, a strength meter and confirm-field validation (contracts minimum length); forced after the seed password or voluntary (`?voluntary=1`) (spec 04 §12.12) */
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { ErrorCode } from '@/components/shared/ErrorState.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { type AppError, toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { AuthLayout } from './AuthLayout.tsx';
import { PasswordInput } from './PasswordInput.tsx';
import { passwordChecks, passwordScore, SCORE_LABEL } from './password-strength.ts';
import { type ChangePasswordForm, changePasswordForm, MIN_PASSWORD } from './schemas.ts';

/** Message for a failed change. */
export function changeErrorMessage(error: AppError): string {
  switch (error.code) {
    case 'BAD_CURRENT_PASSWORD':
      return 'Could not change password: check the current password.';
    case 'WEAK_PASSWORD': {
      const min = error.details['min_length'];
      return `New password is too short (minimum ${typeof min === 'number' ? min : MIN_PASSWORD} characters).`;
    }
    default:
      return error.message;
  }
}

const SCORE_TONE: readonly Tone[] = ['neutral', 'danger', 'warn', 'success', 'success'];

function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  if (message === undefined) return null;
  return (
    <p id={id} role="alert" className="text-sm text-danger-text">
      {message}
    </p>
  );
}

/** Change-password page. */
export function ChangePasswordPage({ voluntary }: { readonly voluntary: boolean }) {
  const { changePassword, state } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState<AppError | null>(null);
  const form = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordForm),
    defaultValues: { current_password: '', new_password: '', confirm_password: '' },
    mode: 'onTouched',
  });
  const errors = form.formState.errors;
  const [current, next, confirm] = form.watch([
    'current_password',
    'new_password',
    'confirm_password',
  ]);
  const checks = passwordChecks({ current, next, confirm });
  const score = passwordScore(next);
  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await changePassword(values.current_password, values.new_password);
      toast.success({ title: 'Password changed', description: 'Other sessions were signed out.' });
      if (voluntary) void navigate({ to: '/overview' });
    } catch (raw) {
      setError(toAppError(raw));
    }
  });
  const forced =
    !voluntary && (state.status === 'change' || state.principal?.must_change_password === true);
  const Check = ICONS.check;
  const Dot = ICONS.minus;
  return (
    <AuthLayout
      title={voluntary ? 'Change password' : 'Set a new password'}
      subtitle={
        forced
          ? 'Replace the seed password before you continue. Other signed-in sessions will be signed out.'
          : 'Other signed-in sessions are signed out when the password changes.'
      }
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="current_password">
            {forced ? 'Current (seed) password' : 'Current password'}
          </Label>
          <PasswordInput
            id="current_password"
            autoComplete="current-password"
            autoFocus
            aria-invalid={errors.current_password !== undefined}
            aria-describedby={errors.current_password !== undefined ? 'err-current' : undefined}
            {...form.register('current_password')}
          />
          <FieldError id="err-current" message={errors.current_password?.message} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="new_password">New password</Label>
          <PasswordInput
            id="new_password"
            autoComplete="new-password"
            aria-invalid={errors.new_password !== undefined}
            aria-describedby="hint-new err-new"
            {...form.register('new_password', {
              onChange: () => {
                if (form.getFieldState('confirm_password').isTouched)
                  void form.trigger('confirm_password');
              },
            })}
          />
          <div className="flex items-center gap-3" aria-hidden={score === 0}>
            <div className="grid flex-1 grid-cols-4 gap-1">
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={cn(
                    'h-1 rounded-full transition-colors',
                    score >= step
                      ? TONE_CLASSES[SCORE_TONE[score] ?? 'neutral'].dot
                      : 'bg-muted dark:bg-white/10',
                  )}
                />
              ))}
            </div>
            <span
              className={cn(
                'min-w-16 text-right text-sm',
                score === 0
                  ? 'text-muted-foreground'
                  : TONE_CLASSES[SCORE_TONE[score] ?? 'neutral'].text,
              )}
            >
              {score === 0 ? `${MIN_PASSWORD}+ chars` : SCORE_LABEL[score]}
            </span>
          </div>
          <FieldError id="err-new" message={errors.new_password?.message} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm_password">Confirm new password</Label>
          <PasswordInput
            id="confirm_password"
            autoComplete="new-password"
            aria-invalid={errors.confirm_password !== undefined}
            aria-describedby={errors.confirm_password !== undefined ? 'err-confirm' : undefined}
            {...form.register('confirm_password')}
          />
          <FieldError id="err-confirm" message={errors.confirm_password?.message} />
        </div>
        <ul id="hint-new" aria-label="Password requirements" className="flex flex-col gap-1.5">
          {checks.map((check) => (
            <li
              key={check.id}
              className={cn(
                'flex items-start gap-2 text-sm',
                check.met ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {check.met ? (
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-text" />
              ) : (
                <Dot aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
              )}
              <span>
                {check.label}
                {check.required ? null : (
                  <span className="text-subtle-foreground"> (recommended)</span>
                )}
                <span className="sr-only">{check.met ? ': met' : ': not met'}</span>
              </span>
            </li>
          ))}
        </ul>
        {error !== null ? (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger-text">
            {changeErrorMessage(error)} <ErrorCode error={error} />
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? <Spinner /> : null}
            {form.formState.isSubmitting ? 'Saving…' : 'Change password'}
          </Button>
          {voluntary ? (
            <Link
              to="/overview"
              className={buttonVariants({ variant: 'ghost', className: 'w-full' })}
            >
              Cancel
            </Link>
          ) : null}
        </div>
      </form>
    </AuthLayout>
  );
}
