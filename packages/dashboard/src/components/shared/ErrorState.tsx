/** @module components/shared/ErrorState — field/region/page error: title, message, hint, copyable code token + request id, Retry/escape; client bugs get "Copy details" instead of a docs code */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import type { AppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { CopyButton, copyText } from './CopyButton.tsx';

/** Props. */
export interface ErrorStateProps {
  readonly tier: 'field' | 'region' | 'page';
  readonly error: AppError;
  readonly onRetry?: () => void;
  readonly escape?: { readonly label: string; readonly to: string };
  readonly title?: string;
  /** Region tier: `panel` gives it its own card surface. */
  readonly variant?: 'inline' | 'panel';
  readonly className?: string;
}

/** Copyable mono code token linking to the error reference. */
export function ErrorCode({
  error,
  className,
}: {
  readonly error: AppError;
  readonly className?: string;
}) {
  return (
    <span
      data-reveal-scope=""
      className={cn('inline-flex items-center gap-0.5 font-mono text-sm', className)}
    >
      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground dark:bg-white/[0.07]">
        {error.code}
      </span>
      <CopyButton value={error.code} label={`Copy error code ${error.code}`} />
    </span>
  );
}

/** Plain-text report of an error for bug reports. */
export function errorDetails(error: AppError, route?: string): string {
  const lines = [
    `${error.title} (${error.code})`,
    error.message,
    ...(route !== undefined ? [`route: ${route}`] : []),
    ...(error.requestId !== undefined ? [`request: ${error.requestId}`] : []),
  ];
  const stack = error.details['stack'];
  if (typeof stack === 'string') lines.push('', stack);
  return lines.join('\n');
}

function CopyDetails({ error }: { readonly error: AppError }) {
  const [copied, setCopied] = useState(false);
  const CopyIcon = copied ? ICONS.check : ICONS.copy;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void copyText(errorDetails(error, window.location.pathname)).then((ok) => {
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <CopyIcon aria-hidden="true" />
      {copied ? 'Copied' : 'Copy details'}
    </Button>
  );
}

/** Error surface. */
export function ErrorState({
  tier,
  error,
  onRetry,
  escape: escapeLink,
  title,
  variant = 'inline',
  className,
}: ErrorStateProps) {
  const Icon = error.isClientBug ? ICONS.bug : ICONS.error;
  if (tier === 'field') {
    return (
      <p
        role="alert"
        className={cn('flex flex-wrap items-center gap-2 text-sm text-danger-text', className)}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span>{error.message}</span>
        <ErrorCode error={error} />
      </p>
    );
  }
  const page = tier === 'page';
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-4 px-6 text-center',
        page ? 'py-16' : 'py-10',
        variant === 'panel' && 'rounded-xl border bg-card shadow-xs dark:shadow-none',
        className,
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-full bg-danger-bg text-danger-text',
          page ? 'size-12' : 'size-10',
        )}
      >
        <Icon aria-hidden="true" className={page ? 'size-6' : 'size-5'} />
      </span>
      <div className="flex max-w-lg flex-col gap-1">
        <p className={cn('font-semibold text-foreground', page ? 'text-lg' : 'text-base')}>
          {title ?? error.title}
        </p>
        {error.message !== '' && error.message !== (title ?? error.title) ? (
          <p className="text-sm text-pretty [overflow-wrap:anywhere] text-muted-foreground">
            {error.message}
          </p>
        ) : null}
        {error.hint !== undefined ? (
          <p className="text-sm text-pretty text-muted-foreground">{error.hint}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <ErrorCode error={error} />
        {error.requestId !== undefined ? (
          <span data-reveal-scope="" className="inline-flex items-center gap-0.5 font-mono">
            req {error.requestId}
            <CopyButton value={error.requestId} label="Copy request id" />
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry !== undefined ? (
          <Button type="button" variant={page ? 'default' : 'outline'} size="sm" onClick={onRetry}>
            <ICONS.refresh aria-hidden="true" />
            Retry
          </Button>
        ) : null}
        {error.isClientBug ? <CopyDetails error={error} /> : null}
        {escapeLink !== undefined ? (
          <Link to={escapeLink.to} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {escapeLink.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
