/** @module features/auth/AuthLayout — signed-out frame: theme menu top-right, brand mark and a centred card (title, optional subtitle) and the document title, toasts */
import { type ReactNode, useEffect } from 'react';
import { ThemeMenu } from '@/app/shell/ThemeMenu.tsx';
import { ToastStack } from '@/app/shell/ToastStack.tsx';
import { BrandMark } from '@/components/shared/brand-mark.tsx';

/** Auth layout. */
export function AuthLayout({
  children,
  title,
  subtitle,
}: {
  readonly children: ReactNode;
  /** Omit for content that brings its own heading (an error state). */
  readonly title?: string;
  readonly subtitle?: ReactNode;
}) {
  // Signed-out pages render outside the shell, whose topbar owns the title elsewhere.
  useEffect(() => {
    if (title !== undefined) document.title = `${title} · BrowserHive`;
  }, [title]);
  return (
    <div className="relative flex min-h-dvh flex-col bg-background">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,color-mix(in_oklch,var(--primary),transparent_90%),transparent)]"
      />
      <header className="relative flex h-(--topbar-height) items-center justify-end px-gutter">
        <ThemeMenu />
      </header>
      <main
        id="main"
        className="relative flex flex-1 flex-col items-center px-gutter pt-[max(2rem,10vh)] pb-16"
      >
        <div className="flex w-full max-w-[25rem] flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-3">
            <BrandMark className="size-11" />
            <span className="text-md font-semibold tracking-tight">BrowserHive</span>
          </div>
          <section
            aria-labelledby={title !== undefined ? 'auth-title' : undefined}
            className="w-full rounded-2xl border bg-card p-6 shadow-md sm:p-8 dark:shadow-dialog"
          >
            {title !== undefined ? (
              <div className="mb-6 flex flex-col gap-1">
                <h1 id="auth-title" className="text-xl font-semibold">
                  {title}
                </h1>
                {subtitle !== undefined ? (
                  <p className="text-sm text-pretty text-muted-foreground">{subtitle}</p>
                ) : null}
              </div>
            ) : null}
            {children}
          </section>
        </div>
      </main>
      <ToastStack />
    </div>
  );
}
