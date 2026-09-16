/** @module components/shared/url-cell — URL with the host emphasised and the path muted, full URL in a tooltip, open/copy floating over its end on hover/focus of the URL */
import type { UrlCategory } from '@browserhive/contracts/enums';
import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { isOpenableUrl, middleTruncate, stripCredentials } from '@/lib/format/urls.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { CopyButton } from './CopyButton.tsx';
import { useRowControlTabIndex, useRowScope } from './row-context.ts';
import { StatusBadge } from './StatusBadge.tsx';

/** Props. */
export interface UrlCellProps {
  readonly url: string | null | undefined;
  /** Category tag before the URL. `public` is the default and is never shown. */
  readonly category?: UrlCategory;
  /** Characters of the path kept at the start / end before middle-truncating. */
  readonly head?: number;
  readonly tail?: number;
  /** Show the copy icon on hover (default `true`). */
  readonly copy?: boolean;
  /** Show the open-in-new-tab icon on hover for `http(s)` URLs (default `true`). */
  readonly external?: boolean;
  readonly className?: string;
}

/** Split a display URL into `host` and `rest` (protocol dropped for http/https). */
export function splitUrl(url: string): { readonly host: string; readonly rest: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
      return { host: parsed.host, rest };
    }
    return { host: `${parsed.protocol}`, rest: url.slice(parsed.protocol.length) };
  } catch {
    return { host: url, rest: '' };
  }
}

/**
 * URL cell. Credentials are stripped from the display and from the copied value.
 *
 * Inside a whole-row link the text is plain and sits under the row link, so clicking the
 * URL opens the row; the full URL moves onto the open button's tooltip. Open/copy float at the end
 * of the cell while the row (or the URL itself, outside tables) is hovered or focused; inside a
 * roving table row they leave the tab order.
 */
export function UrlCell({
  url,
  category,
  head = 24,
  tail = 16,
  copy = true,
  external = true,
  className,
}: UrlCellProps) {
  const row = useRowScope();
  const tabIndex = useRowControlTabIndex();
  const [clipped, setClipped] = useState(true);
  if (url === null || url === undefined || url === '') {
    return <span className="text-muted-foreground">—</span>;
  }
  const safe = stripCredentials(url);
  const { host, rest } = splitUrl(safe);
  const shownRest = middleTruncate(rest, head, tail);
  const External = ICONS.external;
  const openable = external && isOpenableUrl(safe);
  const hasActions = copy || openable;
  const fullUrl = <span className="font-mono break-all">{safe}</span>;
  const middleCut = shownRest !== rest;
  const text = (
    <span
      className="min-w-0 truncate font-mono text-sm"
      data-url={safe}
      // The full-URL tooltip only when something is hidden (middle cut or ellipsis).
      onPointerEnter={
        row?.linked === true
          ? undefined
          : (event) => setClipped(event.currentTarget.scrollWidth > event.currentTarget.clientWidth)
      }
    >
      <span className="text-foreground">{host}</span>
      <span className="text-muted-foreground">{shownRest}</span>
    </span>
  );
  return (
    <span
      data-reveal-scope=""
      className={cn(
        'relative items-center gap-1',
        row !== null ? 'flex w-full min-w-0' : 'inline-flex max-w-full min-w-0',
        className,
      )}
    >
      {category !== undefined && category !== 'public' ? (
        <StatusBadge domain="urlCategory" value={category} variant="pill" className="shrink-0" />
      ) : null}
      {row?.linked === true ? (
        text
      ) : (
        <Hint label={fullUrl} disabled={!middleCut && !clipped}>
          {text}
        </Hint>
      )}
      {hasActions ? (
        // An in-flow slot that opens on hover/focus of the row or value: the URL re-truncates to make
        // room instead of being covered. Hidden on touch, where the row opens the page.
        <span
          data-interactive=""
          className="reveal-slot flex shrink-0 items-center pointer-coarse:hidden"
        >
          <span className="flex items-center">
            {openable ? (
              <Hint
                label={
                  <span className="flex flex-col gap-0.5">
                    <span>Open in a new tab</span>
                    {fullUrl}
                  </span>
                }
              >
                <a
                  href={safe}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open URL in a new tab"
                  tabIndex={tabIndex}
                  className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
                  onClick={(event) => event.stopPropagation()}
                >
                  <External aria-hidden="true" />
                </a>
              </Hint>
            ) : null}
            {copy ? <CopyButton value={safe} label="Copy URL" visibility="always" /> : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}
