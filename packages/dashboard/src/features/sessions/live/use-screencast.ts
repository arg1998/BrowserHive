/** @module features/sessions/live/use-screencast — screencast lifecycle over the socket store: `stream(screencast:<id>)` + `screencast.start/stop/set_size`, JPEG frames drawn onto a canvas via `createImageBitmap` (no React state per frame), latest-wins decoding, 1 Hz stats, reconnect restart; starts only once the pane is measured, sends a debounced `set_size` as it resizes, one retry on `SCREENCAST_FAILED` (spec 04 §13) */
import { SessionId } from '@browserhive/contracts/ids';
import { screencastTopic } from '@browserhive/contracts/ws';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSocket, useSocketState } from '@/app/providers/SocketProvider.tsx';
import type { ScreencastFrame } from '@/lib/ws/store.ts';
import { FrameStats, type FrameStatsSnapshot } from './frame.ts';
import { letterboxRect, type Rect, type Size } from './input-mapping.ts';
import { SET_SIZE_DEBOUNCE_MS } from './stream-size.ts';
import { commandErrorCode } from './ws-error.ts';

/** What the surface shows. */
export type ScreencastStatus =
  | 'off'
  | 'starting'
  | 'waiting'
  | 'streaming'
  | 'paused'
  | 'failed'
  | 'stopped'
  | 'disconnected'
  | 'offline';

/** Options. */
export interface UseScreencastOptions {
  readonly sessionId: string;
  readonly live: boolean;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly dims: { readonly max_width: number; readonly max_height: number };
  readonly quality: number;
  /** Start as soon as the page mounts (default `true`). */
  readonly autoStart?: boolean;
  /**
   * The pane has been measured, so `dims` is the real size (default `true`). Starting before that
   * would open the stream at a guessed size and restart it moments later with `set_size`.
   */
  readonly ready?: boolean;
  readonly clock?: () => number;
}

/** Anything `drawFrame` can paint: an `ImageBitmap` in the browser, a stub in tests. */
export interface FrameImage {
  readonly width: number;
  readonly height: number;
}

/** The subset of a canvas `drawFrame` touches. */
export interface FrameCanvas {
  width: number;
  height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  getContext(kind: '2d'): Pick<CanvasRenderingContext2D, 'clearRect' | 'drawImage'> | null;
}

/**
 * Paint a frame fitted and centred in the canvas (object-fit: contain). The backing store follows
 * the canvas' CSS box × device pixel ratio, so the picture is sharp and fills the pane; the same
 * `letterboxRect` maths maps pointer input back to page coordinates.
 */
export function drawFrame(canvas: FrameCanvas, image: FrameImage, dpr = 1): Rect | null {
  const scale = Math.min(3, Math.max(1, dpr));
  const width = Math.round(canvas.clientWidth * scale);
  const height = Math.round(canvas.clientHeight * scale);
  if (width <= 0 || height <= 0) return null;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const rect = letterboxRect({ width, height }, image);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image as CanvasImageSource, rect.x, rect.y, rect.width, rect.height);
  return rect;
}

/** Decode a JPEG frame into a bitmap (`null` when decoding is unavailable). */
export async function decodeJpeg(frame: ScreencastFrame): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const copy = new Uint8Array(frame.jpeg.byteLength);
  copy.set(frame.jpeg);
  return createImageBitmap(new Blob([copy], { type: 'image/jpeg' }));
}

/**
 * One automatic retry of a start refused with `SCREENCAST_FAILED` (retryable: the daemon tore the
 * CDP bridge down and the next start opens a fresh one). Any other refusal shows Failed at once.
 */
const START_RETRY_DELAY_MS = 1000;

/** Screencast hook. */
export function useScreencast({
  sessionId,
  live,
  canvasRef,
  dims,
  quality,
  autoStart = true,
  ready = true,
  clock = () => performance.now(),
}: UseScreencastOptions) {
  const socket = useSocket();
  const socketState = useSocketState();
  const [wanted, setWanted] = useState(autoStart);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<ScreencastStatus>('off');
  const [failure, setFailure] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<Size | null>(null);
  /** Decoded JPEG size (what the stream sends, after `set_size` scaling). */
  const [streamSize, setStreamSize] = useState<Size | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stats, setStats] = useState<FrameStatsSnapshot>({
    fps: 0,
    dropped: 0,
    received: 0,
    ageMs: null,
  });
  const device = useRef<Size | null>(null);
  const statsRef = useRef(new FrameStats());
  const decoding = useRef(false);
  const pending = useRef<ScreencastFrame | null>(null);
  const lastImage = useRef<ImageBitmap | null>(null);
  const dimsRef = useRef(dims);
  dimsRef.current = dims;
  const sentDims = useRef('');
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const sessionKey = useMemo(() => {
    const parsed = SessionId.safeParse(sessionId);
    return parsed.success ? parsed.data : null;
  }, [sessionId]);
  const connected = socketState.status === 'connected';
  const active = wanted && !paused && live && ready && connected && sessionKey !== null;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const image = lastImage.current;
    if (canvas === null || image === null) return;
    drawFrame(canvas, image, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  }, [canvasRef]);

  const onFrame = useCallback(
    (frame: ScreencastFrame) => {
      statsRef.current.record(frame.header.seq, clockRef.current());
      if (decoding.current) {
        if (pending.current !== null) statsRef.current.skip();
        pending.current = frame;
        return;
      }
      decoding.current = true;
      setStatus((s) => (s === 'streaming' ? s : 'streaming'));
      setFrameSize((prev) =>
        prev !== null && prev.width === frame.header.width && prev.height === frame.header.height
          ? prev
          : { width: frame.header.width, height: frame.header.height },
      );
      const drain = (next: ScreencastFrame): void => {
        void decodeJpeg(next)
          .then((bitmap) => {
            if (bitmap === null) return;
            lastImage.current?.close();
            lastImage.current = bitmap;
            setStreamSize((prev) =>
              prev !== null && prev.width === bitmap.width && prev.height === bitmap.height
                ? prev
                : { width: bitmap.width, height: bitmap.height },
            );
            paint();
          })
          .catch(() => undefined)
          .finally(() => {
            const queued = pending.current;
            pending.current = null;
            if (queued !== null) drain(queued);
            else decoding.current = false;
          });
      };
      drain(frame);
    },
    [paint],
  );

  // Repaint the last frame when the canvas box changes (pane resize, fullscreen).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef, paint]);
  useEffect(
    () => () => {
      lastImage.current?.close();
      lastImage.current = null;
    },
    [],
  );

  // Stream subscription + start/stop. `attempt` restarts it (Retry).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a restart token
  useEffect(() => {
    if (!active || socket === null || sessionKey === null) return undefined;
    const id = sessionKey;
    statsRef.current.reset();
    setFailure(null);
    setStatus('starting');
    const unsubscribe = socket.stream(screencastTopic(id), {
      frame: onFrame,
      control: (control) => {
        if (control.type === 'meta')
          device.current = { width: control.device_width, height: control.device_height };
        else if (control.type === 'stopped')
          setStatus(control.reason === 'stopped' ? 'stopped' : 'offline');
        else if (control.type === 'failed') {
          setFailure(control.code);
          setStatus('failed');
        }
      },
    });
    const { max_width, max_height } = dimsRef.current;
    sentDims.current = `${max_width}x${max_height}`;
    // The daemon serialises start/stop per connection and keeps the CDP bridge through a short
    // grace period, so a re-mount (StrictMode, moving the pane between layouts) is a plain
    // stop → start: the new viewer gets meta and the last frame at once, even on a static page.
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const start = (retried: boolean): void => {
      socket
        .command('screencast.start', { session_id: id, max_width, max_height, quality })
        .then(() => {
          if (!cancelled) setStatus((s) => (s === 'starting' ? 'waiting' : s));
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const code = commandErrorCode(error);
          if (!retried && code === 'SCREENCAST_FAILED') {
            retryTimer = setTimeout(() => start(true), START_RETRY_DELAY_MS);
            return;
          }
          setFailure(code);
          setStatus('failed');
        });
    };
    start(false);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      unsubscribe();
      void socket.command('screencast.stop', { session_id: id }).catch(() => undefined);
    };
  }, [active, socket, sessionKey, quality, onFrame, attempt]);

  // Debounced set_size when the requested dims change while running.
  useEffect(() => {
    if (!active || socket === null || sessionKey === null) return undefined;
    const id = sessionKey;
    const key = `${dims.max_width}x${dims.max_height}`;
    if (key === sentDims.current) return undefined;
    const timer = setTimeout(() => {
      sentDims.current = key;
      void socket
        .command('screencast.set_size', {
          session_id: id,
          max_width: dims.max_width,
          max_height: dims.max_height,
        })
        .catch(() => undefined);
    }, SET_SIZE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, socket, sessionKey, dims.max_width, dims.max_height]);

  // 1 Hz stats.
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setStats(statsRef.current.snapshot(clockRef.current())), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const shown: ScreencastStatus = !live
    ? 'offline'
    : !wanted
      ? 'off'
      : paused
        ? 'paused'
        : !connected
          ? 'disconnected'
          : status === 'off'
            ? 'starting'
            : status;

  return {
    status: shown,
    failure,
    frameSize,
    streamSize,
    device,
    stats,
    /** A frame has been painted (the canvas shows a picture). */
    hasFrame: frameSize !== null,
    start: useCallback(() => {
      setPaused(false);
      setWanted(true);
    }, []),
    stop: useCallback(() => {
      setWanted(false);
      setStatus('off');
    }, []),
    retry: useCallback(() => {
      setPaused(false);
      setWanted(true);
      setStatus('starting');
      setAttempt((n) => n + 1);
    }, []),
    pause: useCallback(() => setPaused(true), []),
    resume: useCallback(() => setPaused(false), []),
  };
}
