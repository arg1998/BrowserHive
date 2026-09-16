/** @module interface/ws/frames — server frame builders over the v1 envelope (spec 03 §6.2, spec 10 §2.3). */

import { ERROR_REGISTRY, type ErrorCode } from '@browserhive/contracts/errors';
import {
  type ScreencastControl,
  WS_PROTOCOL_VERSION,
  type WsFeedEvent,
  type WsReplyPayload,
} from '@browserhive/contracts/ws';
import type { z } from 'zod';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';

/** A feed event payload as producers hand it over (validated before buffering). */
export type FeedEvent = z.output<typeof WsFeedEvent>;

/** `event` frame (ordered, replayable). */
export function eventFrame(seq: number, ts: number, topic: string, payload: FeedEvent): string {
  return JSON.stringify({ v: WS_PROTOCOL_VERSION, kind: 'event', seq, ts, topic, payload });
}

/** `reply` frame; `corr` echoed when the command carried one. */
export function replyFrame(
  seq: number,
  ts: number,
  payload: z.input<typeof WsReplyPayload>,
  corr?: string,
): string {
  return JSON.stringify({
    v: WS_PROTOCOL_VERSION,
    kind: 'reply',
    seq,
    ts,
    ...(corr !== undefined && { corr }),
    payload,
  });
}

/** `stream` frame (screencast control on `screencast:<id>`, never buffered). */
export function streamFrame(
  seq: number,
  ts: number,
  topic: string,
  payload: z.input<typeof ScreencastControl>,
): string {
  return JSON.stringify({ v: WS_PROTOCOL_VERSION, kind: 'stream', seq, ts, topic, payload });
}

/** `error` frame projected from any thrown value (unknown errors → `INTERNAL_ERROR`). */
export function errorFrame(
  seq: number,
  ts: number,
  error: unknown,
  corr?: string,
  requestId?: string,
): string {
  const appError = isAppError(error)
    ? error
    : new AppError('INTERNAL_ERROR', { ref: requestId ?? 'ws' }, { cause: error });
  return JSON.stringify({
    v: WS_PROTOCOL_VERSION,
    kind: 'error',
    seq,
    ts,
    ...(corr !== undefined && { corr }),
    payload: errorPayload(appError.code, appError.details, requestId),
  });
}

function errorPayload(code: ErrorCode, details: unknown, requestId: string | undefined) {
  const spec = ERROR_REGISTRY[code];
  const hasDetails =
    typeof details === 'object' && details !== null && Object.keys(details).length > 0;
  return {
    code,
    title: spec.title,
    ...(spec.hint !== undefined && { hint: spec.hint }),
    ...(hasDetails && { details }),
    ...(requestId !== undefined && { request_id: requestId }),
  };
}
