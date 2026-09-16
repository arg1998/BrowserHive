/** @module features/logs/use-log-stream — wires the log buffer: seeds from the newest REST page, tails the `logs` topic (filtered client-side, batched), fills the gap after a WS reconnect with `after_seq` (no wipe), restarts on a daemon epoch change, loads older pages by cursor */
import type { UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useSocketState, useTopic } from '@/app/providers/SocketProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { browserClock } from '@/lib/clock.ts';
import type { SocketStatus } from '@/lib/ws/store.ts';
import { fetchLogGap, fetchOlderLogs, useLogsHead } from './api.ts';
import {
  enqueueLive,
  initialLogBuffer,
  type LiveBatch,
  type LogBufferState,
  logBufferReducer,
  type PauseReason,
} from './log-buffer.ts';
import { logsFilterKey, matchesLogFilters } from './log-filters.ts';
import type { LogsSearch } from './search.ts';

/** Live records are applied in batches at most this often (a busy tail re-renders ~10×/s, not per record). */
const FLUSH_MS = 100;

/** What the stream exposes. */
export interface LogStream {
  readonly buffer: LogBufferState;
  readonly head: UseQueryResult<unknown, unknown>;
  /** `false` for a closed window (`until` set): no live tail. */
  readonly tailing: boolean;
  readonly connection: SocketStatus;
  readonly olderPending: boolean;
  /** A reconnect gap could not be filled completely (the ring evicted records meanwhile). */
  readonly gap: boolean;
  readonly loadOlder: () => void;
  readonly pause: (reason: PauseReason) => void;
  readonly resume: () => void;
}

/** Live log stream for the URL filters. */
export function useLogStream(search: LogsSearch): LogStream {
  const api = useApi();
  const toast = useToast();
  const socket = useSocketState();
  const tailing = search.until === undefined;
  // The key changes with the filters, and with the daemon epoch only once one was known (a restarted
  // daemon restarts `seq`, so its records cannot merge with the old ones).
  const epochs = useRef<{ epoch: string | null; generation: number }>({
    epoch: null,
    generation: 0,
  });
  if (socket.epoch !== null && socket.epoch !== epochs.current.epoch) {
    if (epochs.current.epoch !== null) epochs.current.generation += 1;
    epochs.current.epoch = socket.epoch;
  }
  const key = `${epochs.current.generation}|${logsFilterKey(search)}`;
  const [buffer, dispatch] = useReducer(logBufferReducer, key, initialLogBuffer);
  const head = useLogsHead(search);
  const [olderPending, setOlderPending] = useState(false);
  const [gap, setGap] = useState(false);

  const searchRef = useRef(search);
  searchRef.current = search;
  const keyRef = useRef(key);
  keyRef.current = key;
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;

  const queue = useRef<LiveBatch>({ key, records: [] });

  // A new filter set or daemon epoch starts a new buffer; the reset time gates which REST data may seed it.
  const resetAt = useRef(0);
  useEffect(() => {
    resetAt.current = browserClock();
    // Records batched under the previous filters must not land in the new buffer.
    queue.current = { key, records: [] };
    dispatch({ type: 'reset', key });
    setGap(false);
  }, [key]);

  // Seed (and re-merge after refetches) only with data fetched for this buffer.
  const { data: headData, dataUpdatedAt } = head;
  useEffect(() => {
    if (headData === undefined || dataUpdatedAt < resetAt.current) return;
    dispatch({
      type: 'seed',
      key: keyRef.current,
      page: { data: headData.data, next_cursor: headData.page.next_cursor },
    });
  }, [headData, dataUpdatedAt]);

  // Batched live tail. The batch remembers the buffer key its records were matched for: the key can
  // change between enqueue and flush, and the reducer drops a batch whose key is stale.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    timer.current = null;
    const batch = queue.current;
    queue.current = { key: batch.key, records: [] };
    if (batch.records.length > 0)
      dispatch({ type: 'live', key: batch.key, records: batch.records });
  }, []);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useTopic(tailing ? 'logs' : null, (event) => {
    if (event.type !== 'log.record') return;
    if (!matchesLogFilters(event.record, searchRef.current)) return;
    queue.current = enqueueLive(queue.current, keyRef.current, event.record);
    if (timer.current === null) timer.current = setTimeout(flush, FLUSH_MS);
  });

  // Reconnect: fill the gap from the highest seq seen instead of re-seeding.
  // `null` until the first connection; `false` after a connection dropped.
  const wasConnected = useRef<boolean | null>(null);
  useEffect(() => {
    const connected = socket.status === 'connected';
    const previous = wasConnected.current;
    if (connected) wasConnected.current = true;
    else if (previous === true) wasConnected.current = false;
    if (!connected || previous !== false || !tailing) return;
    const snapshot = bufferRef.current;
    if (!snapshot.seeded || snapshot.maxSeq === 0 || snapshot.key !== keyRef.current) return;
    const forKey = keyRef.current;
    const afterSeq = snapshot.maxSeq;
    void fetchLogGap(api, searchRef.current, afterSeq)
      .then(({ records, complete }) => {
        dispatch({ type: 'live', key: forKey, records });
        if (!complete) setGap(true);
      })
      .catch(() => setGap(true));
  }, [socket.status, api, tailing]);

  const loadOlder = useCallback(() => {
    const cursor = bufferRef.current.olderCursor;
    if (cursor === null) return;
    const forKey = keyRef.current;
    setOlderPending(true);
    fetchOlderLogs(api, searchRef.current, cursor)
      .then((page) =>
        dispatch({
          type: 'older',
          key: forKey,
          page: { data: page.data, next_cursor: page.page.next_cursor },
        }),
      )
      .catch((error: unknown) => toast.fromError(toAppError(error), 'Could not load older records'))
      .finally(() => setOlderPending(false));
  }, [api, toast]);

  const pause = useCallback((reason: PauseReason) => dispatch({ type: 'pause', reason }), []);
  const resume = useCallback(() => dispatch({ type: 'resume' }), []);

  return {
    buffer,
    head,
    tailing,
    connection: socket.status,
    olderPending,
    gap,
    loadOlder,
    pause,
    resume,
  };
}
