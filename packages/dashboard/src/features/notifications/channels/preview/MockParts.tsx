/** @module features/notifications/channels/preview/MockParts — pieces shared by the platform mocks: the screenshot stand-in (previews never carry image bytes) and the BrowserHive sender avatar */
import type { ReactNode } from 'react';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/**
 * Stands in for an attached screenshot: a small browser frame with page skeleton lines, and black
 * bars over the "form fields" when the channel masks them (D-36).
 */
export function MockScreenshot({
  masked,
  name,
  className,
}: {
  readonly masked: boolean;
  readonly name: string;
  readonly className?: string;
}) {
  const Camera = ICONS.toolScreenshot;
  return (
    <figure
      className={cn(
        'relative flex aspect-[16/9] w-full flex-col overflow-hidden bg-gradient-to-br from-secondary to-muted text-muted-foreground dark:from-white/[0.09] dark:to-white/[0.04]',
        className,
      )}
      aria-label={`Attached screenshot (${name})${masked ? ', form fields masked' : ''}`}
    >
      <div className="flex h-5 shrink-0 items-center gap-1 bg-black/5 px-2 dark:bg-white/5">
        <span className="size-1.5 rounded-full bg-current opacity-40" />
        <span className="size-1.5 rounded-full bg-current opacity-40" />
        <span className="size-1.5 rounded-full bg-current opacity-40" />
        <span className="ml-2 h-2.5 w-2/5 rounded-full bg-current opacity-15" />
      </div>
      <div className="flex flex-1 items-center justify-center gap-6 px-6">
        <div className="flex w-2/5 flex-col gap-2">
          <span className="h-2.5 w-3/4 rounded-full bg-current opacity-25" />
          <span className="h-2 w-full rounded-full bg-current opacity-15" />
          <span className="h-2 w-5/6 rounded-full bg-current opacity-15" />
        </div>
        <div className="flex w-2/5 flex-col gap-2">
          {[0, 1].map((n) => (
            <span
              key={n}
              className={cn(
                'h-4 w-full rounded-sm border border-current/25',
                masked ? 'bg-foreground' : 'bg-card dark:bg-white/10',
              )}
            />
          ))}
          <span className="h-4 w-1/2 rounded-sm bg-current opacity-30" />
        </div>
      </div>
      <figcaption className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-xs text-white">
        <Camera aria-hidden="true" className="size-3" />
        {masked ? 'screenshot · fields masked' : 'screenshot'}
      </figcaption>
    </figure>
  );
}

/** BrowserHive's sender avatar (the brand gradient with a hive glyph). */
export function SenderAvatar({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-(--brand-from) to-(--brand-to) text-xs font-semibold text-white',
        className,
      )}
    >
      BH
    </span>
  );
}

/** A mock button: a real link for URL buttons, an inert button for act buttons (they work in the chat). */
export function MockAction({
  url,
  className,
  children,
}: {
  readonly url: string | null;
  readonly className: string;
  readonly children: ReactNode;
}) {
  if (url !== null) {
    return (
      <a href={url} target="_blank" rel="noreferrer noopener" className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={className} title="Pressed in the chat app">
      {children}
    </button>
  );
}
