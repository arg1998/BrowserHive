/** @module components/shared/image-zoom-modal — Base UI dialog: fit on open, 0.25×–8×, wheel-to-cursor, drag pan, double-click fit ↔ 2.4×, `+ - 0 Esc`, header dims/bytes/zoom %, "Open raw", "no longer on disk" state (spec 04 §7) */
import type { ReactNode } from 'react';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { EmptyState } from './EmptyState.tsx';
import { useImageZoom, ZOOM } from './use-image-zoom.ts';

/** Props. */
export interface ImageZoomModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly src: string;
  readonly title: string;
  /** Dims · bytes · capture kind, shown under the title. */
  readonly subtitle?: ReactNode;
  readonly alt?: string;
  /** Raw authenticated URL for "Open raw" (defaults to `src`). */
  readonly rawHref?: string;
}

/** Image zoom modal. */
export function ImageZoomModal({
  open,
  onOpenChange,
  src,
  title,
  subtitle,
  alt,
  rawHref,
}: ImageZoomModalProps) {
  const { zoom, dragging, failed, setFailed, reset, zoomBy, surfaceRef, imgRef, pointer } =
    useImageZoom(open, src);

  const ZoomIn = ICONS.zoomIn;
  const ZoomOut = ICONS.zoomOut;
  const External = ICONS.external;
  const Close = ICONS.close;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-2 p-2 sm:max-w-[calc(100%-2rem)]"
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate font-mono text-sm">{title}</DialogTitle>
            {subtitle !== undefined ? (
              <DialogDescription className="text-xs text-muted-foreground">
                {subtitle}
              </DialogDescription>
            ) : null}
          </div>
          <span className="min-w-12 text-right font-mono text-sm text-muted-foreground tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <Hint label="Zoom out" shortcut="−">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => zoomBy(1 / ZOOM.step)}
            >
              <ZoomOut aria-hidden="true" />
            </Button>
          </Hint>
          <Hint label="Zoom in" shortcut="+">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              onClick={() => zoomBy(ZOOM.step)}
            >
              <ZoomIn aria-hidden="true" />
            </Button>
          </Hint>
          <Hint label="Fit to window" shortcut="0">
            <Button type="button" variant="outline" size="sm" onClick={reset}>
              Fit
            </Button>
          </Hint>
          <a
            href={rawHref ?? src}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <External aria-hidden="true" /> Open raw
          </a>
          <Hint label="Close" shortcut="Esc">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              onClick={() => onOpenChange(false)}
            >
              <Close aria-hidden="true" />
            </Button>
          </Hint>
        </div>
        {/* Every action here is also on a real button above; the surface only pans. */}
        <div
          ref={surfaceRef}
          className={cn(
            'relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden rounded-md bg-muted/40 select-none',
            dragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
          {...pointer}
        >
          {failed ? (
            <EmptyState
              kind="zero-data"
              icon="error"
              title="Screenshot is no longer on disk"
              description="The file this frame was captured to has been removed — by the retention sweep, or because the session's data directory was deleted. The record of the call remains."
            />
          ) : (
            <img
              ref={imgRef}
              src={src}
              alt={alt ?? title}
              draggable={false}
              onError={() => setFailed(true)}
              className="max-h-full max-w-full translate-x-(--pan-x) translate-y-(--pan-y) scale-(--zoom) object-contain"
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Scroll to zoom · drag to pan · double-click to toggle · <Kbd>Esc</Kbd> to close
        </p>
      </DialogContent>
    </Dialog>
  );
}
