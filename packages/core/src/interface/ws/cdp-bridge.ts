/** @module interface/ws/cdp-bridge — the CDP surface live view uses, and its Playwright `CDPSession` adapter (type-only Playwright). */

import type { CDPSession, Page } from 'playwright';
import type { Session } from '../../domain/session/session.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
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

/** Adapts a Playwright `CDPSession`. */
export function cdpSessionBridge(cdp: CDPSession): CdpBridge {
  return {
    async startScreencast(params) {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: params.quality,
        maxWidth: params.maxWidth,
        maxHeight: params.maxHeight,
        everyNthFrame: 1,
      });
    },
    async stopScreencast() {
      await cdp.send('Page.stopScreencast');
    },
    async ackFrame(frameSessionId) {
      await cdp.send('Page.screencastFrameAck', { sessionId: frameSessionId });
    },
    async captureFrame(quality) {
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality });
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
    const handle = session.handle;
    if (handle === null) {
      throw new AppError('SESSION_NOT_AVAILABLE', {
        session_id: session.id,
        state: session.state.kind,
      });
    }
    const cdp = await handle.context.newCDPSession(pageOf(session));
    return cdpSessionBridge(cdp);
  };
}
