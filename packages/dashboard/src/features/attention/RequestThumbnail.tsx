/** @module features/attention/RequestThumbnail — the session's most recent stored screenshot beside an open request (there is no live-thumbnail endpoint; the caption says how old the capture is relative to the request), opens the zoom modal; renders nothing when the session has no screenshots */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { ImageZoomModal } from '@/components/shared/image-zoom-modal.tsx';
import { keys } from '@/lib/api/keys.ts';
import { formatDuration } from '@/lib/format/time.ts';

/** Props. */
export interface RequestThumbnailProps {
  readonly sessionId: string;
  readonly requestedAt: number;
}

/** "3m 10s before the request" / "at the request" / "12s after the request". */
export function captureOffset(capturedAt: number, requestedAt: number): string {
  const delta = capturedAt - requestedAt;
  if (Math.abs(delta) < 1_000) return 'at the request';
  return `${formatDuration(Math.abs(delta))} ${delta < 0 ? 'before' : 'after'} the request`;
}

/** Latest screenshot thumbnail. */
export function RequestThumbnail({ sessionId, requestedAt }: RequestThumbnailProps) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const query = { limit: 1, sort: 'ts', dir: 'desc' } as const;
  const shots = useQuery({
    queryKey: keys.sessions.screenshots(sessionId, query),
    queryFn: () => api.listSessionScreenshots({ params: { session_id: sessionId }, query }),
    staleTime: 15_000,
  });
  const shot = shots.data?.data[0];
  if (shot === undefined || broken) return null;
  const caption = `Last screenshot · ${captureOffset(shot.ts, requestedAt)}`;
  return (
    <figure className="hidden w-full shrink-0 flex-col gap-1.5 md:flex lg:w-64">
      <button
        type="button"
        aria-label={`Open ${caption.toLowerCase()}`}
        className="group/thumb relative aspect-[16/10] w-full overflow-hidden rounded-lg border bg-muted transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong hover:shadow-sm"
        onClick={() => setOpen(true)}
      >
        <img
          src={shot.url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover object-top transition-transform duration-(--duration-base) group-hover/thumb:scale-[1.02]"
          onError={() => setBroken(true)}
        />
      </button>
      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
      <ImageZoomModal
        open={open}
        onOpenChange={setOpen}
        src={shot.url}
        title="Last screenshot"
        subtitle={`${shot.width}×${shot.height} · ${captureOffset(shot.ts, requestedAt)}`}
      />
    </figure>
  );
}
