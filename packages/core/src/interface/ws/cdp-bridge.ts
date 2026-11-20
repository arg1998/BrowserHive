/** @module interface/ws/cdp-bridge — the CDP surface live view uses, and its Playwright `CDPSession` adapter (type-only Playwright). */

import type { Session } from '../../domain/session/session.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { CDPSession, Page } from '../../ports/page-types.ts';
import type { KeyEventParams, MouseEventParams, TouchEventParams } from './live-input.ts';

/** Page geometry attached to a frame (`Page.ScreencastFrameMetadata`, the fields live view uses). */
export interface CdpFrameMetadata {
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly pageScaleFactor: number;
  readonly offsetTop: number;
}

/** A still frame captured outside the screencast (the initial frame of an unchanging page). */
export interface CdpCapturedFrame {
  /** Base64 JPEG. */
  readonly data: string;
  readonly metadata: CdpFrameMetadata;
}

/** One `Page.screencastFrame` event. */
export interface CdpScreencastFrame extends CdpCapturedFrame {
  /** Ack id. */
  readonly sessionId: number;
}

/** Screencast start parameters. */
export interface ScreencastParams {
  readonly quality: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/** The CDP calls live view makes (one bridge per session). */
export interface CdpBridge {
  startScreencast(params: ScreencastParams): Promise<void>;
  stopScreencast(): Promise<void>;
  ackFrame(frameSessionId: number): Promise<void>;
  /**
   * A JPEG of the current viewport at `quality`, with the same metadata a screencast frame carries.
   * CDP only emits screencast frames when the page changes, so this primes viewers of a static page.
   */
  captureFrame(quality: number): Promise<CdpCapturedFrame>;
  onFrame(listener: (frame: CdpScreencastFrame) => void): () => void;
  dispatchMouseEvent(params: MouseEventParams): Promise<void>;
  dispatchKeyEvent(params: KeyEventParams): Promise<void>;
  dispatchTouchEvent(params: TouchEventParams): Promise<void>;
  detach(): Promise<void>;
}

/** Opens a bridge for a live session. */
export type CdpBridgeFactory = (session: Session) => Promise<CdpBridge>;

/**
 * What DevTools answers a `Page` call while a navigation swaps the page's frame host (a new tab's
 * `about:blank` committing its first URL): the same call on the same session works once the
 * navigation committed. A bridge opened in that window (the agent's `new_tab` and `navigate` right
 * after it) otherwise failed its screencast for good (D30 d; measured on Linux: an attach about 5 ms
 * into the navigation fails `Page.startScreencast` every time, and a retry after the commit works).
 */
export const FRAME_SWAP_MESSAGE = 'Not attached to an active page';
/** Pause between two tries of a call refused during a frame swap. */
export const FRAME_SWAP_RETRY_MS = 25;
/** Tries of a call refused during a frame swap (80 × 25 ms: two seconds, within the initial-frame limit). */
export const FRAME_SWAP_TRIES = 80;

/** Options of {@link cdpSessionBridge} (test seam). */
export interface CdpSessionBridgeOptions {
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Runs `call`, trying again while DevTools refuses it during a frame swap. */
async function acrossFrameSwap<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(FRAME_SWAP_MESSAGE) || attempt >= FRAME_SWAP_TRIES) throw error;
      await sleep(FRAME_SWAP_RETRY_MS);
    }
  }
}

/** Adapts a Playwright `CDPSession`. */
export function cdpSessionBridge(
  cdp: CDPSession,
  options: CdpSessionBridgeOptions = {},
): CdpBridge {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async startScreencast(params) {
      await acrossFrameSwap(
        () =>
          cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: params.quality,
            maxWidth: params.maxWidth,
            maxHeight: params.maxHeight,
            everyNthFrame: 1,
          }),
        sleep,
      );
    },
    async stopScreencast() {
      await cdp.send('Page.stopScreencast');
    },
    async ackFrame(frameSessionId) {
      await cdp.send('Page.screencastFrameAck', { sessionId: frameSessionId });
    },
    async captureFrame(quality) {
      const metrics = await acrossFrameSwap(() => cdp.send('Page.getLayoutMetrics'), sleep);
      const shot = await acrossFrameSwap(
        () => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality }),
        sleep,
      );
      const viewport = metrics.cssVisualViewport;
      return {
        data: shot.data,
        metadata: {
          deviceWidth: viewport.clientWidth,
          deviceHeight: viewport.clientHeight,
          pageScaleFactor: viewport.scale,
          offsetTop: 0,
        },
      };
    },
    onFrame(listener) {
      const handler = (event: CdpScreencastFrame) => listener(event);
      cdp.on('Page.screencastFrame', handler);
      return () => {
        cdp.off('Page.screencastFrame', handler);
      };
    },
    async dispatchMouseEvent(params) {
      await cdp.send('Input.dispatchMouseEvent', { ...params });
    },
    async dispatchKeyEvent(params) {
      await cdp.send('Input.dispatchKeyEvent', { ...params });
    },
    async dispatchTouchEvent(params) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: params.type,
        touchPoints: params.touchPoints.map((p) => ({ ...p })),
        modifiers: params.modifiers,
      });
    },
    async detach() {
      await cdp.detach();
    },
  };
}

/**
 * The production factory: a fresh `CDPSession` on the session's active page (`pageOf` is
 * `SessionService.page`). Throws `SESSION_NOT_AVAILABLE` when the browser is not attached.
 */
export function playwrightBridgeFactory(pageOf: (session: Session) => Page): CdpBridgeFactory {
  return async (session) => {
    const view = session.view;
    if (view === null) {
      throw new AppError('SESSION_NOT_AVAILABLE', {
        session_id: session.id,
        state: session.state.kind,
      });
    }
    const cdp = await view.newCDPSession(pageOf(session));
    return cdpSessionBridge(cdp);
  };
}
