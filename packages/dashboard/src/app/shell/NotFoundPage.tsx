/** @module app/shell/NotFoundPage — 404 content rendered inside the shell with its own document title */
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';

/** 404 page body. */
export function NotFoundPage() {
  const router = useRouter();
  const path = router.state.location.pathname;
  useEffect(() => {
    document.title = 'Page not found · BrowserHive';
  }, []);
  const Icon = ICONS.notFound;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground dark:bg-white/[0.06]">
        <Icon aria-hidden="true" className="size-6" />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-base text-muted-foreground">
          Nothing lives at <code className="font-mono text-sm text-foreground">{path}</code>. The
          address may be mistyped, or the page may have moved.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link to="/overview" className={buttonVariants({ variant: 'default' })}>
          Go to Overview
        </Link>
        <Button type="button" variant="outline" onClick={() => router.history.back()}>
          <ICONS.arrowLeft aria-hidden="true" /> Go back
        </Button>
      </div>
    </div>
  );
}
