/** @module lib/client-errors — client error sink: reports boundary errors and wire mismatches to `POST /client-errors`, rate limited 5/min (spec 04 §5) */
import type { Clock } from './clock.ts';

/** A report before enrichment. */
export interface ClientErrorInput {
  readonly message: string;
  readonly stack?: string;
  readonly route: string;
}

/** What the sink posts. */
export interface ClientErrorPayload extends ClientErrorInput {
  readonly user_agent: string;
  readonly build: string;
}

/** Sink options. */
export interface ClientErrorSinkOptions {
  readonly post: (payload: ClientErrorPayload) => Promise<void>;
  readonly build: string;
  readonly userAgent: string;
  readonly clock: Clock;
  /** Reports per minute before dropping (spec 04 §5: 5). */
  readonly limitPerMinute?: number;
}

/** The sink. */
export interface ClientErrorSink {
  /** Fire-and-forget; returns `false` when rate limited. */
  readonly report: (input: ClientErrorInput) => boolean;
}

/** Build a sink. */
export function createClientErrorSink(options: ClientErrorSinkOptions): ClientErrorSink {
  const limit = options.limitPerMinute ?? 5;
  const stamps: number[] = [];
  return {
    report(input) {
      const now = options.clock();
      while (stamps.length > 0 && now - (stamps[0] ?? 0) > 60_000) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(now);
      const payload: ClientErrorPayload = {
        message: input.message.slice(0, 2000),
        ...(input.stack !== undefined && { stack: input.stack.slice(0, 16_000) }),
        route: input.route.slice(0, 512),
        user_agent: options.userAgent.slice(0, 512),
        build: options.build.slice(0, 128),
      };
      options.post(payload).catch(() => {
        // The sink must never throw into the boundary that called it.
      });
      return true;
    },
  };
}

/** Build identifier baked in by Vite (`VITE_BUILD`), `dev` otherwise. */
export function buildId(): string {
  const value: unknown = import.meta.env['VITE_BUILD'];
  return typeof value === 'string' && value.length > 0 ? value : 'dev';
}
