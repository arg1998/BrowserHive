/** @module features/sessions/live/live-status — what the live pane tells the operator: one status pill (Live · Idle · Connecting · Reconnecting · Paused · Ended · Failed · Stopped) with the stream numbers in its popover, and the takeover gate (an open `takeover` attention request, never `counts`) */
import type { OperatorRequestRow, SessionSummary } from '@browserhive/contracts/http';
import { formatNumber } from '@/lib/format/bytes.ts';
import type { Tone } from '@/lib/status-registry.ts';
import type { FrameStatsSnapshot } from './frame.ts';
import type { Size } from './input-mapping.ts';
import type { ScreencastStatus } from './use-screencast.ts';

/** Frames older than this read as "Idle": the screencast only sends frames when pixels change. */
export const IDLE_AFTER_MS = 2500;

/** Pill state. */
export type LivePillState =
  | 'live'
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'paused'
  | 'ended'
  | 'failed'
  | 'stopped';

/** Pill copy. */
export const LIVE_PILL: {
  readonly [K in LivePillState]: {
    readonly label: string;
    readonly tone: Tone;
    readonly pulse?: boolean;
    readonly hint: string;
  };
} = {
  live: {
    label: 'Live',
    tone: 'success',
    pulse: true,
    hint: 'Frames are arriving as the page changes.',
  },
  idle: {
    label: 'Idle',
    tone: 'neutral',
    hint: 'Connected. No new frames because the page is not changing — this is normal.',
  },
  connecting: { label: 'Connecting', tone: 'info', pulse: true, hint: 'Starting the screencast…' },
  reconnecting: {
    label: 'Reconnecting',
    tone: 'warn',
    pulse: true,
    hint: 'The dashboard lost its connection to the daemon and is retrying. The last frame is frozen.',
  },
  paused: {
    label: 'Paused',
    tone: 'neutral',
    hint: 'You paused the stream. The last frame is frozen.',
  },
  ended: {
    label: 'Ended',
    tone: 'neutral',
    hint: 'The session has closed, so there is nothing left to stream.',
  },
  failed: { label: 'Failed', tone: 'danger', hint: 'The screencast could not run.' },
  stopped: { label: 'Stopped', tone: 'neutral', hint: 'The daemon stopped the screencast.' },
};

/** Map the screencast state (plus frame age) to the pill. */
export function livePillState(status: ScreencastStatus, ageMs: number | null): LivePillState {
  switch (status) {
    case 'streaming':
      return ageMs !== null && ageMs > IDLE_AFTER_MS ? 'idle' : 'live';
    case 'off':
    case 'starting':
    case 'waiting':
      return 'connecting';
    case 'disconnected':
      return 'reconnecting';
    case 'paused':
      return 'paused';
    case 'offline':
      return 'ended';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'connecting';
  }
}

/** One row of the stream numbers in the status popover. */
export interface StreamStat {
  readonly label: string;
  readonly value: string;
}

/**
 * The stream numbers for the status popover, as label/value rows: the page size the agent sees, the
 * size the stream is scaled to for this pane, frame rate, dropped frames (only when some were) and
 * the age of the last frame. `null` before the first frame.
 */
export function streamStats(
  frameSize: Size | null,
  streamSize: Size | null,
  stats: FrameStatsSnapshot,
): readonly StreamStat[] | null {
  if (frameSize === null) return null;
  const rows: StreamStat[] = [{ label: 'Page', value: `${frameSize.width}×${frameSize.height}` }];
  if (
    streamSize !== null &&
    (streamSize.width !== frameSize.width || streamSize.height !== frameSize.height)
  ) {
    rows.push({ label: 'Stream', value: `${streamSize.width}×${streamSize.height}` });
  }
  rows.push({ label: 'Frame rate', value: `${stats.fps} fps` });
  if (stats.dropped > 0) rows.push({ label: 'Dropped', value: formatNumber(stats.dropped) });
  if (stats.ageMs !== null) {
    rows.push({
      label: 'Last frame',
      value:
        stats.ageMs < 1000
          ? 'just now'
          : `${(stats.ageMs / 1000).toFixed(stats.ageMs < 10_000 ? 1 : 0)} s ago`,
    });
  }
  return rows;
}

/**
 * The open takeover request that lets the operator drive the browser, or `null`. The server's input
 * gate requires a *pending* attention request with `mode === 'takeover'`; `notify`
 * requests and `session.counts.attention_open` are not enough.
 */
export function takeoverRequest(
  session: Pick<SessionSummary, 'live'>,
  pending: readonly OperatorRequestRow[] | undefined,
): OperatorRequestRow | null {
  if (!session.live || pending === undefined) return null;
  return (
    pending.find(
      (request) =>
        request.kind === 'attention' && request.status === 'pending' && request.mode === 'takeover',
    ) ?? null
  );
}
