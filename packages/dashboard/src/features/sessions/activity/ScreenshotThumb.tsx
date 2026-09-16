/** @module features/sessions/activity/ScreenshotThumb — lazy screenshot thumbnail button that opens the zoom modal; caption `1280×720 · 84 KB · agent capture`; a "no longer on disk" state when the file is gone */
import type { ScreenshotKind } from '@browserhive/contracts/http';
import { useState } from 'react';
import { ImageZoomModal } from '@/components/shared/image-zoom-modal.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatBytes } from '@/lib/format/bytes.ts';
import { formatClock } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface ScreenshotThumbProps {
  readonly src: string;
  readonly tool: string;
  readonly ts: number;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly sizeBytes?: number | undefined;
  readonly kind?: ScreenshotKind | undefined;
  /** `row`: 56×36 inline thumbnail; `card`: fills its grid cell at the capture's aspect ratio; `detail`: up to 12rem tall. */
  readonly variant?: 'row' | 'card' | 'detail';
  readonly className?: string;
}

/** Caption text: `1280×720 · 84 KB · agent capture`. */
export function screenshotCaption(
  p: Pick<ScreenshotThumbProps, 'width' | 'height' | 'sizeBytes' | 'kind'>,
): string {
  const parts: string[] = [];
  if (p.width !== undefined && p.height !== undefined) parts.push(`${p.width}×${p.height}`);
  if (p.sizeBytes !== undefined) parts.push(formatBytes(p.sizeBytes));
  if (p.kind !== undefined) parts.push(p.kind === 'tool' ? 'agent capture' : 'trace frame');
  return parts.join(' · ');
}

/** Thumbnail button + zoom modal. */
export function ScreenshotThumb({ variant = 'detail', className, ...props }: ScreenshotThumbProps) {
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const caption = screenshotCaption(props);
  const title = `${props.tool} · ${formatClock(props.ts)}`;
  const ImageIcon = ICONS.image;
  if (missing) {
    return variant === 'row' ? null : (
      <p
        className={cn(
          'flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground',
          variant === 'card' && 'aspect-video justify-center text-center',
          className,
        )}
      >
        <ImageIcon aria-hidden="true" className="size-4 shrink-0" />
        Screenshot no longer on disk
      </p>
    );
  }
  return (
    <>
      <Hint label={variant === 'row' ? 'View screenshot' : null}>
        <button
          type="button"
          aria-label={`Open screenshot ${title}`}
          className={cn(
            'group/shot relative block shrink-0 overflow-hidden rounded-md border bg-muted transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong hover:shadow-sm dark:bg-black/30',
            variant === 'row' && 'h-9 w-14',
            variant === 'card' && 'w-full rounded-lg',
            variant === 'detail' && 'max-w-full',
            className,
          )}
          {...(variant === 'card' && {
            // The capture's own aspect ratio, so a 16:9 page is not cropped into a 16:10 tile.
            style: {
              aspectRatio:
                props.width !== undefined && props.height !== undefined && props.height > 0
                  ? `${props.width} / ${props.height}`
                  : '16 / 9',
            },
          })}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <img
            src={props.src}
            alt=""
            loading="lazy"
            decoding="async"
            className={cn(
              variant === 'detail'
                ? 'block h-auto max-h-48 w-auto max-w-full'
                : 'size-full object-cover object-top',
            )}
            onError={() => setMissing(true)}
          />
        </button>
      </Hint>
      <ImageZoomModal
        open={open}
        onOpenChange={setOpen}
        src={props.src}
        title={title}
        subtitle={caption}
      />
    </>
  );
}
