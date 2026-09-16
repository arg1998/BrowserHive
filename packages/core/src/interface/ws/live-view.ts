/** @module interface/ws/live-view — one lazy CDP screencast bridge per session, fanned out to viewers, serialised per session, following the active tab; operator input and viewport (spec 03 §6.7). */

import { type LiveInput, SCREENCAST_QUALITY } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { Session } from '../../domain/session/session.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  CdpBridge,
  CdpBridgeFactory,
  CdpCapturedFrame,
  CdpScreencastFrame,
} from './cdp-bridge.ts';
import { keyParams, mouseParams, touchParams } from './live-input.ts';
import {
  frameOf,
  KeyedSerial,
  type LiveFrame,
  type LiveMeta,
  metaOf,
  reasonOf,
  type Schedule,
  withTimeout,
} from './live-view-support.ts';

export type { LiveFrame, LiveMeta, Schedule } from './live-view-support.ts';

/** Grace before the last viewer leaving stops the screencast. */
export const SCREENCAST_GRACE_MS = 5_000;
/** Requested size when a viewer names none. */
export const DEFAULT_SCREENCAST_SIZE = { width: 1280, height: 720 } as const;
/** How long the initial-frame capture may take before it is abandoned. */
export const INITIAL_FRAME_TIMEOUT_MS = 3_000;

/** One watcher (a WS connection's screencast). */
export interface ScreencastViewer {
  readonly id: string;
  maxWidth: number;
  maxHeight: number;
  frame(frame: LiveFrame): void;
  meta(meta: LiveMeta): void;
  stopped(reason: 'session_closed' | 'session_crashed'): void;
  /** The shared stream died (CDP failure); the viewer has already been removed. */
  failed(error: AppError): void;
}

/** Dependencies of {@link LiveView}. */
export interface LiveViewDeps {
  readonly sessions: { peek(sessionId: string): Session | undefined };
  readonly bridges: CdpBridgeFactory;
  /** The active Playwright page of a session (`SessionService.page`). */
  readonly pageOf: (session: Session) => {
    setViewportSize(size: { width: number; height: number }): Promise<void>;
    viewportSize(): { width: number; height: number } | null;
  };
  readonly logger: Logger;
  readonly schedule: Schedule;
  /** `--screencastQuality`. */
  readonly quality?: number;
  readonly graceMs?: number;
  /** Humanize cursor resync after an accepted operator mouse input (takeover). */
  readonly onOperatorPointer?: (session: Session, x: number, y: number) => void;
  /** Humanize cursor invalidation after a viewport change. */
  readonly onViewportChanged?: (session: Session) => void;
}

interface ViewerEntry {
  readonly viewer: ScreencastViewer;
  /** The meta this viewer last received (JSON), so every viewer gets meta before its first frame. */
  metaKey: string | undefined;
  /** False until the viewer's first frame; only such viewers get the last frame replayed. */
  primed: boolean;
}

interface Bridge {
  readonly cdp: CdpBridge;
  /** The tab the CDP session is attached to. */
  readonly tabId: string | undefined;
  readonly viewers: Map<string, ViewerEntry>;
  screencasting: boolean;
  size: { width: number; height: number };
  lastFrame: LiveFrame | undefined;
  lastMeta: LiveMeta | undefined;
  /** Frames published so far; a capture that loses the race to a real frame is discarded. */
  frames: number;
  priming: boolean;
  closed: boolean;
  release: () => void;
  cancelStop: (() => void) | undefined;
}

const LIVE_STATES: ReadonlySet<string> = new Set(['live', 'paused']);

/**
 * Live view manager: lazy shared screencasts, input dispatch, viewport. Every change to a session's
 * bridge (join, leave, resize, grace stop, tab retarget, close) runs on one per-session queue, so a
 * stop and a start racing each other always apply in arrival order against a consistent bridge.
 */
export class LiveView {
  private readonly bridges = new Map<string, Bridge>();
  private readonly queue = new KeyedSerial();
  private readonly captures = new Set<Promise<void>>();
  private readonly log: Logger;

  constructor(private readonly deps: LiveViewDeps) {
    this.log = deps.logger.child({ module: 'ws.live_view' });
  }

  /** Number of sessions currently screencasting. */
  get activeCount(): number {
    return [...this.bridges.values()].filter((b) => b.screencasting).length;
  }

  /** True when the session has at least one viewer. */
  hasViewers(sessionId: string): boolean {
    return (this.bridges.get(sessionId)?.viewers.size ?? 0) > 0;
  }

  /**
   * Adds a viewer; starts (or re-sizes) the screencast, then sends the viewer the last meta and
   * frame, or captures one when none exists or the stream was restarted.
   * @throws `SESSION_NOT_FOUND`, `SESSION_NOT_AVAILABLE`, or `SCREENCAST_FAILED` (bridge torn down).
   */
  async addViewer(sessionId: string, viewer: ScreencastViewer): Promise<void> {
    await this.queue.run(sessionId, async () => {
      const bridge = await this.ensureBridge(sessionId);
      clearStop(bridge);
      const entry: ViewerEntry = { viewer, metaKey: undefined, primed: false };
      bridge.viewers.set(viewer.id, entry);
      let restarted: boolean;
      try {
        restarted = await this.applySize(bridge);
      } catch (error) {
        bridge.viewers.delete(viewer.id);
        throw await this.fail(sessionId, bridge, error);
      }
      if (bridge.lastFrame !== undefined && !entry.primed) {
        this.deliver(bridge, entry, bridge.lastFrame);
      }
      if (restarted || bridge.lastFrame === undefined) this.prime(sessionId, bridge);
    });
  }

  /** Removes a viewer; the last one leaving stops the screencast after the grace period. Never rejects. */
  removeViewer(sessionId: string, viewerId: string): Promise<void> {
    return this.queue
      .run(sessionId, async () => {
        const bridge = this.bridges.get(sessionId);
        if (bridge === undefined || !bridge.viewers.delete(viewerId)) return;
        if (bridge.viewers.size === 0) {
          this.scheduleStop(sessionId, bridge);
          return;
        }
        try {
          if (await this.applySize(bridge)) this.prime(sessionId, bridge);
        } catch (error) {
          await this.fail(sessionId, bridge, error);
        }
      })
      .catch((error: unknown) =>
        this.log.warn('screencast leave failed', { session_id: sessionId, err: error }),
      );
  }

  /**
   * Changes one viewer's requested size; CDP is re-issued with the largest across viewers and a
   * fresh frame is pushed. @throws `SCREENCAST_FAILED` when not watching or CDP refuses.
   */
  async setViewerSize(
    sessionId: string,
    viewerId: string,
    width: number,
    height: number,
  ): Promise<void> {
    await this.queue.run(sessionId, async () => {
      const bridge = this.bridges.get(sessionId);
      const entry = bridge?.viewers.get(viewerId);
      if (bridge === undefined || entry === undefined) {
        throw new AppError('SCREENCAST_FAILED', { session_id: sessionId, reason: 'not watching' });
      }
      entry.viewer.maxWidth = width;
      entry.viewer.maxHeight = height;
      try {
        if (await this.applySize(bridge)) this.prime(sessionId, bridge);
      } catch (error) {
        throw await this.fail(sessionId, bridge, error);
      }
    });
  }

  /** Dispatches one operator input (the caller checked the attention gate). */
  async sendInput(sessionId: string, input: z.output<typeof LiveInput>): Promise<void> {
    const session = this.requireLive(sessionId);
    const bridge = await this.queue.run(sessionId, async () => {
      const opened = await this.ensureBridge(sessionId);
      if (opened.viewers.size === 0) this.scheduleStop(sessionId, opened);
      return opened;
    });
    switch (input.type) {
      case 'mouse':
        await bridge.cdp.dispatchMouseEvent(mouseParams(input));
        try {
          this.deps.onOperatorPointer?.(session, input.x, input.y);
        } catch (error) {
          this.log.debug('cursor resync failed', { session_id: sessionId, err: error });
        }
        return;
      case 'key':
        await bridge.cdp.dispatchKeyEvent(keyParams(input));
        return;
      case 'touch':
        await bridge.cdp.dispatchTouchEvent(touchParams(input));
        return;
    }
  }

  /** Resizes the active page viewport; never attention-gated (D-10). */
  async setViewport(
    sessionId: string,
    width: number,
    height: number,
  ): Promise<{ width: number; height: number }> {
    const session = this.requireLive(sessionId);
    const page = this.deps.pageOf(session);
    await page.setViewportSize({ width, height });
    this.deps.onViewportChanged?.(session);
    return page.viewportSize() ?? { width, height };
  }

  /** Session closed or crashed: viewers get `stopped`, the bridge is torn down. */
  async sessionClosed(sessionId: string, crashed: boolean): Promise<void> {
    await this.queue.run(sessionId, async () => {
      const bridge = this.bridges.get(sessionId);
      if (bridge === undefined) return;
      const viewers = [...bridge.viewers.values()];
      bridge.viewers.clear();
      for (const { viewer } of viewers) {
        viewer.stopped(crashed ? 'session_crashed' : 'session_closed');
      }
      await this.teardown(sessionId, bridge);
    });
  }

  /** Resolves once queued bridge work and in-flight initial-frame captures have settled. */
  async settled(): Promise<void> {
    await this.queue.idle();
    while (this.captures.size > 0) await Promise.allSettled([...this.captures]);
  }

  /** Tears every bridge down (shutdown). */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.bridges].map(([id, bridge]) => this.teardown(id, bridge)));
  }

  private get quality(): number {
    return this.deps.quality ?? SCREENCAST_QUALITY.default;
  }

  private requireLive(sessionId: string): Session {
    const session = this.deps.sessions.peek(sessionId);
    if (session === undefined) {
      throw new AppError(
        'SESSION_NOT_FOUND',
        { session_id: sessionId },
        { publicMessage: `No browser session with id '${sessionId}'` },
      );
    }
    if (!LIVE_STATES.has(session.state.kind) || session.handle === null) {
      throw new AppError('SESSION_NOT_AVAILABLE', {
        session_id: sessionId,
        state: session.state.kind,
      });
    }
    return session;
  }

  /** The session's bridge on its active tab (opened or re-targeted as needed). Queue-held. */
  private async ensureBridge(sessionId: string): Promise<Bridge> {
    const session = this.requireLive(sessionId);
    const existing = this.bridges.get(sessionId);
    if (existing === undefined) return this.openBridge(session);
    if (existing.tabId === session.tabs.activeTabId()) return existing;
    return (await this.retarget(session, existing)) ?? this.openBridge(session);
  }

  private async openBridge(session: Session): Promise<Bridge> {
    const tabId = session.tabs.activeTabId();
    let cdp: CdpBridge;
    try {
      cdp = await this.deps.bridges(session);
    } catch (error) {
      throw screencastFailed(session.id, error);
    }
    const bridge: Bridge = {
      cdp,
      tabId,
      viewers: new Map(),
      screencasting: false,
      size: { width: 0, height: 0 },
      lastFrame: undefined,
      lastMeta: undefined,
      frames: 0,
      priming: false,
      closed: false,
      release: () => undefined,
      cancelStop: undefined,
    };
    const offFrame = cdp.onFrame((frame) => this.onFrame(session.id, bridge, frame));
    const offTab = session.tabs.onActiveChange(() => this.followTab(session.id, bridge));
    bridge.release = () => {
      offFrame();
      offTab();
    };
    this.bridges.set(session.id, bridge);
    if (session.tabs.activeTabId() !== tabId) this.followTab(session.id, bridge);
    return bridge;
  }

  /** The agent switched tabs: move the bridge (and its viewers) to the new active page. */
  private followTab(sessionId: string, bridge: Bridge): void {
    void this.queue
      .run(sessionId, async () => {
        const session = this.deps.sessions.peek(sessionId);
        if (bridge.closed || session === undefined || session.handle === null) return;
        if (!LIVE_STATES.has(session.state.kind)) return;
        const active = session.tabs.activeTabId();
        if (active === undefined || active === bridge.tabId) return;
        await this.retarget(session, bridge);
      })
      .catch((error: unknown) =>
        this.log.warn('screencast retarget failed', { session_id: sessionId, err: error }),
      );
  }

  /**
   * Replaces `old` with a bridge on the active tab, carrying its viewers over (they get fresh meta
   * and a frame). Without viewers the old bridge is only torn down and `undefined` is returned.
   */
  private async retarget(session: Session, old: Bridge): Promise<Bridge | undefined> {
    const carried = [...old.viewers.values()];
    old.viewers.clear();
    await this.teardown(session.id, old);
    if (carried.length === 0) return undefined;
    let next: Bridge;
    try {
      next = await this.openBridge(session);
    } catch (error) {
      const failure = screencastFailed(session.id, error);
      for (const { viewer } of carried) viewer.failed(failure);
      throw failure;
    }
    for (const { viewer } of carried)
      next.viewers.set(viewer.id, { viewer, metaKey: undefined, primed: false });
    try {
      await this.applySize(next);
    } catch (error) {
      throw await this.fail(session.id, next, error);
    }
    this.prime(session.id, next);
    this.log.debug('screencast retargeted', {
      session_id: session.id,
      ...(next.tabId !== undefined && { tab_id: next.tabId }),
    });
    return next;
  }

  /** (Re)issues `Page.startScreencast` at the largest viewer size; true when it (re)started. */
  private async applySize(bridge: Bridge): Promise<boolean> {
    if (bridge.viewers.size === 0) return false;
    let width = 0;
    let height = 0;
    for (const { viewer } of bridge.viewers.values()) {
      width = Math.max(width, viewer.maxWidth);
      height = Math.max(height, viewer.maxHeight);
    }
    if (bridge.screencasting && width === bridge.size.width && height === bridge.size.height) {
      return false;
    }
    // Chromium refuses a second `Page.startScreencast` while one is active on the CDP session.
    if (bridge.screencasting) {
      bridge.screencasting = false;
      await bridge.cdp.stopScreencast();
    }
    await bridge.cdp.startScreencast({ quality: this.quality, maxWidth: width, maxHeight: height });
    bridge.size = { width, height };
    bridge.screencasting = true;
    return true;
  }

  /**
   * Pushes a captured frame unless a screencast frame arrives first: CDP only emits frames when the
   * page changes, so a static page would otherwise leave new viewers blank.
   */
  private prime(sessionId: string, bridge: Bridge): void {
    if (bridge.priming) return;
    bridge.priming = true;
    const seen = bridge.frames;
    const capture = withTimeout(
      this.deps.schedule,
      bridge.cdp.captureFrame(this.quality),
      INITIAL_FRAME_TIMEOUT_MS,
      'initial frame capture',
    )
      .then((shot) => {
        if (bridge.closed || bridge.frames !== seen) return;
        this.publish(bridge, shot);
      })
      .catch((error: unknown) =>
        this.log.debug('initial frame failed', { session_id: sessionId, err: error }),
      )
      .finally(() => {
        bridge.priming = false;
        this.captures.delete(capture);
      });
    this.captures.add(capture);
  }

  private onFrame(sessionId: string, bridge: Bridge, frame: CdpScreencastFrame): void {
    if (bridge.closed) return;
    void bridge.cdp
      .ackFrame(frame.sessionId)
      .catch((error: unknown) =>
        this.log.debug('frame ack failed', { session_id: sessionId, err: error }),
      );
    this.publish(bridge, frame);
  }

  private publish(bridge: Bridge, shot: CdpCapturedFrame): void {
    const meta = metaOf(shot.metadata);
    const frame = frameOf(shot.data, meta);
    bridge.frames += 1;
    bridge.lastMeta = meta;
    bridge.lastFrame = frame;
    for (const entry of bridge.viewers.values()) this.deliver(bridge, entry, frame);
  }

  /** Sends `frame` to one viewer, preceded by meta when it differs from what the viewer has. */
  private deliver(bridge: Bridge, entry: ViewerEntry, frame: LiveFrame): void {
    const meta = bridge.lastMeta;
    if (meta !== undefined) {
      const key = JSON.stringify(meta);
      if (key !== entry.metaKey) {
        entry.metaKey = key;
        entry.viewer.meta(meta);
      }
    }
    entry.primed = true;
    entry.viewer.frame(frame);
  }

  private scheduleStop(sessionId: string, bridge: Bridge): void {
    clearStop(bridge);
    bridge.cancelStop = this.deps.schedule(() => {
      void this.queue
        .run(sessionId, async () => {
          if (bridge.viewers.size === 0) await this.teardown(sessionId, bridge);
        })
        .catch((error: unknown) =>
          this.log.debug('screencast stop failed', { session_id: sessionId, err: error }),
        );
    }, this.deps.graceMs ?? SCREENCAST_GRACE_MS);
  }

  /** Tears the bridge down and notifies its remaining viewers; returns the error to throw. */
  private async fail(sessionId: string, bridge: Bridge, error: unknown): Promise<AppError> {
    const failure = screencastFailed(sessionId, error);
    this.log.warn('screencast failed', { session_id: sessionId, err: error });
    const viewers = [...bridge.viewers.values()];
    bridge.viewers.clear();
    await this.teardown(sessionId, bridge);
    for (const { viewer } of viewers) viewer.failed(failure);
    return failure;
  }

  private async teardown(sessionId: string, bridge: Bridge): Promise<void> {
    if (bridge.closed) return;
    bridge.closed = true;
    if (this.bridges.get(sessionId) === bridge) this.bridges.delete(sessionId);
    clearStop(bridge);
    bridge.release();
    try {
      if (bridge.screencasting) await bridge.cdp.stopScreencast();
    } catch (error) {
      this.log.debug('screencast stop failed', { session_id: sessionId, err: error });
    }
    bridge.screencasting = false;
    try {
      await bridge.cdp.detach();
    } catch (error) {
      this.log.debug('cdp detach failed', { session_id: sessionId, err: error });
    }
  }
}

function clearStop(bridge: Bridge): void {
  bridge.cancelStop?.();
  bridge.cancelStop = undefined;
}

function screencastFailed(sessionId: string, error: unknown): AppError {
  if (isAppError(error)) return error;
  return new AppError(
    'SCREENCAST_FAILED',
    { session_id: sessionId, reason: reasonOf(error) },
    { cause: error },
  );
}
