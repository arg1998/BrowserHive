/** @module interface/ws/live-view.test — lazy shared bridge, largest-viewer sizing (restart, not double start), frame ack/fan-out, initial capture, per-session serialisation of join/leave/grace stop, failure recovery, tab retarget, input mapping, viewport, session close. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeBrowserDriver } from '../../../test/helpers/fake-browser-driver.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { FakePage } from '../../../test/helpers/fake-page.ts';
import { InProcessEventBus } from '../../app/events/bus.ts';
import type { DomainEvents } from '../../app/events/catalog.ts';
import { SessionService } from '../../app/sessions/session-service.ts';
import { FakeSessionDirFs, testConfig } from '../../app/sessions/test-support.ts';
import type { AppError } from '../../kernel/errors/app-error.ts';
import type { CdpBridge, CdpCapturedFrame, CdpScreencastFrame } from './cdp-bridge.ts';
import {
  type LiveFrame,
  type LiveMeta,
  LiveView,
  SCREENCAST_GRACE_MS,
  type ScreencastViewer,
} from './live-view.ts';

/** Applied to the next bridge the factory opens (set before the race under test). */
const OPERATOR_WS = { principalId: 'admin', via: 'ws' } as const;

const nextBridge: { failStart?: Error; captureGate?: Promise<void> } = {};

const METADATA = { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0 };

/** Behaves like a Chromium CDP session: a second `Page.startScreencast` while active is refused. */
class FakeBridge implements CdpBridge {
  readonly calls: string[] = [];
  readonly params: unknown[] = [];
  active = false;
  detached = false;
  failStart: Error | undefined;
  captureGate: Promise<void> | undefined;
  private listener: ((frame: CdpScreencastFrame) => void) | undefined;

  constructor(readonly tab: string | undefined) {
    this.failStart = nextBridge.failStart;
    this.captureGate = nextBridge.captureGate;
    delete nextBridge.failStart;
    delete nextBridge.captureGate;
  }

  async startScreencast(params: unknown) {
    await Promise.resolve();
    this.calls.push('start');
    this.params.push(params);
    if (this.detached) throw new Error('Target page, context or browser has been closed');
    if (this.failStart !== undefined) throw this.failStart;
    if (this.active)
      throw new Error('Protocol error (Page.startScreencast): Screencast is already active');
    this.active = true;
  }
  async stopScreencast() {
    await Promise.resolve();
    this.calls.push('stop');
    this.active = false;
  }
  async ackFrame(id: number) {
    this.calls.push(`ack:${id}`);
  }
  async captureFrame(): Promise<CdpCapturedFrame> {
    this.calls.push('capture');
    await this.captureGate;
    return {
      data: Buffer.from([9]).toString('base64'),
      metadata: { ...METADATA, deviceWidth: 1280, deviceHeight: 720 },
    };
  }
  onFrame(listener: (frame: CdpScreencastFrame) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async dispatchMouseEvent(p: unknown) {
    this.calls.push('mouse');
    this.params.push(p);
  }
  async dispatchKeyEvent(p: unknown) {
    this.calls.push('key');
    this.params.push(p);
  }
  async dispatchTouchEvent(p: unknown) {
    this.calls.push('touch');
    this.params.push(p);
  }
  async detach() {
    this.calls.push('detach');
    this.detached = true;
  }
  emit(sessionId: number, bytes = [1, 2]) {
    this.listener?.({ data: Buffer.from(bytes).toString('base64'), sessionId, metadata: METADATA });
  }
}

async function harness() {
  const clock = new FakeClock();
  const logger = new CollectingLogger();
  const sessions = new SessionService({
    clock,
    ids: new FakeIdGenerator(),
    logger,
    bus: new InProcessEventBus<DomainEvents>({ clock, logger }),
    driver: new FakeBrowserDriver(),
    proxyResolver: { resolve: async (r) => r.requested },
    config: testConfig({ maxSessions: 'unbounded' }),
    fs: new FakeSessionDirFs(),
  });
  const session = await sessions.create({ slug: 'live' }, { subject: 'admin' });
  const opened: FakeBridge[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const pointers: number[] = [];
  const audited: [string, string, string][] = [];
  const live = new LiveView({
    sessions,
    bridges: async (s) => {
      await Promise.resolve();
      const bridge = new FakeBridge(s.tabs.activeTabId());
      opened.push(bridge);
      return bridge;
    },
    pageOf: (s) => sessions.page(s),
    logger,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onOperatorPointer: (_s, x) => pointers.push(x),
    onOperatorInput: (sessionId, actor, kind) => audited.push([sessionId, actor.via, kind]),
  });
  const bridge = () => {
    const last = opened.at(-1);
    if (last === undefined) throw new Error('no bridge opened');
    return last;
  };
  /** Fires the pending grace timers (not capture timeouts) and waits for the queue. */
  const fireGrace = async () => {
    for (const t of timers.filter((t) => t.ms === SCREENCAST_GRACE_MS && !t.cancelled)) {
      t.cancelled = true;
      t.fn();
    }
    await live.settled();
  };
  return { sessions, session, opened, bridge, live, timers, pointers, audited, logger, fireGrace };
}

function viewer(id: string, width: number, height: number) {
  const frames: LiveFrame[] = [];
  const metas: LiveMeta[] = [];
  const stops: string[] = [];
  const failures: AppError[] = [];
  const events: string[] = [];
  const v: ScreencastViewer = {
    id,
    maxWidth: width,
    maxHeight: height,
    frame: (f) => {
      frames.push(f);
      events.push('frame');
    },
    meta: (m) => {
      metas.push(m);
      events.push('meta');
    },
    stopped: (r) => stops.push(r),
    failed: (e) => failures.push(e),
  };
  return { v, frames, metas, stops, failures, events };
}

describe('LiveView', () => {
  it('shares one bridge, sizes to the largest viewer, pushes a captured initial frame with meta', async () => {
    const h = await harness();
    const a = viewer('a', 800, 600);
    const b = viewer('b', 1920, 1080);
    await Promise.all([h.live.addViewer(h.session.id, a.v), h.live.addViewer(h.session.id, b.v)]);
    await h.live.settled();
    expect(h.opened).toHaveLength(1);
    expect(h.bridge().params.at(-1)).toMatchObject({
      maxWidth: 1920,
      maxHeight: 1080,
      quality: 70,
    });
    expect(h.bridge().calls.filter((c) => c === 'start')).toHaveLength(2);
    expect(h.bridge().calls).toContain('capture');
    expect(a.events.slice(0, 2)).toEqual(['meta', 'frame']);
    expect(a.frames[0]).toMatchObject({ width: 1280, height: 720 });
    expect(a.metas[0]).toEqual({
      deviceWidth: 1280,
      deviceHeight: 720,
      pageScale: 1,
      offsetTop: 0,
    });
    expect(b.events.slice(0, 2)).toEqual(['meta', 'frame']);
    expect(h.live.hasViewers(h.session.id)).toBe(true);
    expect(h.live.activeCount).toBe(1);
  });

  it('set_size restarts the screencast (stop, then start) instead of a refused second start', async () => {
    const h = await harness();
    const a = viewer('a', 800, 600);
    await h.live.addViewer(h.session.id, a.v);
    await h.live.setViewerSize(h.session.id, 'a', 1024, 768);
    await h.live.settled();
    expect(h.bridge().calls.filter((c) => c === 'start' || c === 'stop')).toEqual([
      'start',
      'stop',
      'start',
    ]);
    expect(h.bridge().params.at(-1)).toMatchObject({ maxWidth: 1024, maxHeight: 768 });
    // A fresh frame follows the resize (static page: captured).
    expect(h.bridge().calls.filter((c) => c === 'capture')).toHaveLength(2);
    // Same size again is a no-op.
    await h.live.setViewerSize(h.session.id, 'a', 1024, 768);
    expect(h.bridge().calls.filter((c) => c === 'start')).toHaveLength(2);
  });

  it('does not push a stale capture once a real screencast frame arrived', async () => {
    const h = await harness();
    const a = viewer('a', 800, 600);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    nextBridge.captureGate = gate;
    await h.live.addViewer(h.session.id, a.v);
    h.bridge().emit(42);
    release?.();
    await h.live.settled();
    expect(h.bridge().calls).toContain('ack:42');
    expect(a.frames).toHaveLength(1);
    expect(a.frames[0]).toMatchObject({ width: 800, height: 600 });
  });

  it('acks and fans out frames; late viewers get meta and the last frame without a restart', async () => {
    const h = await harness();
    const a = viewer('a', 800, 600);
    await h.live.addViewer(h.session.id, a.v);
    await h.live.settled();
    h.bridge().emit(42);
    expect(h.bridge().calls).toContain('ack:42');
    expect(a.frames.at(-1)).toMatchObject({ width: 800, height: 600 });
    const late = viewer('late', 100, 100);
    await h.live.addViewer(h.session.id, late.v);
    expect(late.events).toEqual(['meta', 'frame']);
    expect(late.frames[0]?.jpeg).toEqual(new Uint8Array([1, 2]));
    expect(h.bridge().calls.filter((c) => c === 'start')).toHaveLength(1);
  });

  it('stops after the grace period once the last viewer leaves', async () => {
    const h = await harness();
    await h.live.addViewer(h.session.id, viewer('a', 1, 1).v);
    await h.live.removeViewer(h.session.id, 'a');
    expect(h.bridge().calls).not.toContain('stop');
    await h.fireGrace();
    expect(h.bridge().calls).toContain('stop');
    expect(h.bridge().calls).toContain('detach');
    expect(h.live.hasViewers(h.session.id)).toBe(false);
    expect(h.live.activeCount).toBe(0);
  });

  it('StrictMode join → leave → join without awaiting keeps one working stream', async () => {
    const h = await harness();
    const first = viewer('c1', 1280, 720);
    const second = viewer('c1', 1280, 720);
    const starts = [
      h.live.addViewer(h.session.id, first.v),
      h.live.removeViewer(h.session.id, 'c1'),
      h.live.addViewer(h.session.id, second.v),
    ];
    await Promise.all(starts);
    await h.fireGrace();
    expect(h.opened).toHaveLength(1);
    expect(h.bridge().active).toBe(true);
    expect(h.live.hasViewers(h.session.id)).toBe(true);
    h.bridge().emit(7);
    expect(second.frames.length).toBeGreaterThan(0);
    expect(second.frames.at(-1)?.jpeg).toEqual(new Uint8Array([1, 2]));
  });

  it('a join racing the grace teardown gets a fresh bridge that streams', async () => {
    const h = await harness();
    await h.live.addViewer(h.session.id, viewer('a', 800, 600).v);
    await h.live.removeViewer(h.session.id, 'a');
    const grace = h.timers.find((t) => t.ms === SCREENCAST_GRACE_MS && !t.cancelled);
    grace?.fn();
    const b = viewer('b', 800, 600);
    await h.live.addViewer(h.session.id, b.v);
    await h.live.settled();
    expect(h.opened).toHaveLength(2);
    expect(h.opened[0]?.detached).toBe(true);
    expect(h.bridge().active).toBe(true);
    h.bridge().emit(1);
    expect(b.frames.at(-1)?.jpeg).toEqual(new Uint8Array([1, 2]));
  });

  it('a failed start is SCREENCAST_FAILED, leaks no viewer, and the next start recovers', async () => {
    const h = await harness();
    const a = viewer('a', 800, 600);
    nextBridge.failStart = new Error('Protocol error: boom');
    await expect(h.live.addViewer(h.session.id, a.v)).rejects.toMatchObject({
      code: 'SCREENCAST_FAILED',
      details: { reason: 'Protocol error: boom' },
    });
    expect(h.live.hasViewers(h.session.id)).toBe(false);
    expect(h.bridge().detached).toBe(true);
    expect(h.logger.records.some((r) => r.level === 'warn' && r.msg === 'screencast failed')).toBe(
      true,
    );
    const b = viewer('b', 800, 600);
    await h.live.addViewer(h.session.id, b.v);
    await h.live.settled();
    expect(h.opened).toHaveLength(2);
    expect(b.frames).toHaveLength(1);
  });

  it('a resize failure fails every viewer of the stream', async () => {
    const h = await harness();
    const a = viewer('a', 800, 600);
    const b = viewer('b', 800, 600);
    await h.live.addViewer(h.session.id, a.v);
    await h.live.addViewer(h.session.id, b.v);
    h.bridge().failStart = new Error('gone');
    await expect(h.live.setViewerSize(h.session.id, 'a', 900, 900)).rejects.toMatchObject({
      code: 'SCREENCAST_FAILED',
    });
    expect(a.failures.map((e) => e.code)).toEqual(['SCREENCAST_FAILED']);
    expect(b.failures.map((e) => e.code)).toEqual(['SCREENCAST_FAILED']);
    expect(h.live.hasViewers(h.session.id)).toBe(false);
  });

  it('set_size for a viewer that is not watching is SCREENCAST_FAILED', async () => {
    const h = await harness();
    await expect(h.live.setViewerSize(h.session.id, 'ghost', 100, 100)).rejects.toMatchObject({
      code: 'SCREENCAST_FAILED',
      details: { reason: 'not watching' },
    });
  });

  it('follows the agent to another tab: re-attaches, restarts and re-sends meta and a frame', async () => {
    const h = await harness();
    const a = viewer('a', 800, 600);
    await h.live.addViewer(h.session.id, a.v);
    await h.live.settled();
    const first = h.bridge();
    const tabId = h.session.tabs.add(new FakePage().page);
    h.session.tabs.setActive(tabId);
    await h.live.settled();
    expect(h.opened).toHaveLength(2);
    expect(first.detached).toBe(true);
    expect(h.bridge().tab).toBe(tabId);
    expect(h.bridge().active).toBe(true);
    expect(a.events).toEqual(['meta', 'frame', 'meta', 'frame']);
    h.bridge().emit(3);
    expect(a.frames.at(-1)?.jpeg).toEqual(new Uint8Array([1, 2]));
  });

  it('maps input to CDP with defaults and resyncs the cursor after mouse input', async () => {
    const h = await harness();
    await h.live.sendInput(
      h.session.id,
      { type: 'mouse', action: 'mousePressed', x: 5, y: 6 },
      OPERATOR_WS,
    );
    expect(h.bridge().params.at(-1)).toEqual({
      type: 'mousePressed',
      x: 5,
      y: 6,
      button: 'left',
      clickCount: 1,
      modifiers: 0,
    });
    await h.live.sendInput(
      h.session.id,
      { type: 'touch', action: 'touchStart', points: [{ x: 1, y: 2 }] },
      OPERATOR_WS,
    );
    expect(h.bridge().params.at(-1)).toEqual({
      type: 'touchStart',
      touchPoints: [{ x: 1, y: 2 }],
      modifiers: 0,
    });
    expect(h.pointers).toEqual([5]);
    expect(h.opened).toHaveLength(1);
  });

  it('reports each input the browser accepted for the audit, and none it rejected', async () => {
    const h = await harness();
    await h.live.sendInput(
      h.session.id,
      { type: 'key', action: 'keyDown', key: 'a' },
      { principalId: 'admin', via: 'rest' },
    );
    expect(h.audited).toEqual([[h.session.id, 'rest', 'key']]);
    h.bridge().dispatchKeyEvent = async () => {
      throw new Error('Target closed');
    };
    await expect(
      h.live.sendInput(h.session.id, { type: 'key', action: 'keyUp', key: 'a' }, OPERATOR_WS),
    ).rejects.toThrow('Target closed');
    expect(h.audited).toHaveLength(1);
  });

  it('setViewport resizes the page; unknown sessions are SESSION_NOT_FOUND', async () => {
    const h = await harness();
    const size = await h.live.setViewport(h.session.id, 1024, 768);
    expect(size).toEqual({ width: 1024, height: 768 });
    await expect(h.live.setViewport('ghost-00000009', 1, 1)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(h.live.addViewer('ghost-00000009', viewer('x', 1, 1).v)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('session close sends stopped to viewers and tears the bridge down', async () => {
    const h = await harness();
    const a = viewer('a', 1, 1);
    await h.live.addViewer(h.session.id, a.v);
    await h.live.sessionClosed(h.session.id, true);
    expect(a.stops).toEqual(['session_crashed']);
    expect(h.bridge().calls).toContain('detach');
  });
});
