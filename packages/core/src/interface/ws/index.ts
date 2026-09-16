/** @module interface/ws — realtime surface: `createRealtimeHub(deps)` wires hub + live view + feed; `websocket` handler for `Bun.serve`. */

import type { DomainEvents } from '../../app/events/catalog.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { LogsPort } from '../http/services.ts';
import type { CdpBridgeFactory } from './cdp-bridge.ts';
import { wireFeed } from './feed.ts';
import { RealtimeHub, type RealtimeHubDeps } from './hub.ts';
import { LiveView, type LiveViewDeps, type Schedule } from './live-view.ts';
import { type WebSocketHandler, websocketHandler } from './upgrade.ts';

export {
  type CdpBridge,
  type CdpBridgeFactory,
  cdpSessionBridge,
  playwrightBridgeFactory,
} from './cdp-bridge.ts';
export { WsConnection } from './connection.ts';
export { topicsForEvent, wireFeed } from './feed.ts';
export { RealtimeHub, type RealtimeHubDeps } from './hub.ts';
export { DEFAULT_HUB_LIMITS, type HubLimits } from './hub-support.ts';
export { LiveView, type LiveViewDeps, type Schedule, type ScreencastViewer } from './live-view.ts';
export { bunSocket, type WsSocket } from './socket.ts';
export {
  type UpgradedSocket,
  upgradeHandler,
  type WebSocketHandler,
  websocketHandler,
} from './upgrade.ts';

/** Heartbeat/reap and `system.tick` cadence. */
export const SWEEP_INTERVAL_MS = 15_000;

/** Everything `createRealtimeHub` needs. */
export interface CreateRealtimeHubDeps
  extends Omit<RealtimeHubDeps, 'liveView'>,
    Omit<LiveViewDeps, 'bridges' | 'logger' | 'schedule'> {
  readonly bus: EventBus<DomainEvents>;
  readonly bridges: CdpBridgeFactory;
  readonly logs?: LogsPort;
  readonly schedule: Schedule;
  /** Repeating timer seam; returns a cancel. */
  readonly every: (fn: () => void, ms: number) => () => void;
}

/** The realtime subsystem as the composition root sees it. */
export interface Realtime {
  readonly hub: RealtimeHub;
  readonly liveView: LiveView;
  readonly websocket: WebSocketHandler;
  /** Starts the bus fan-out, the reaper and the 30 s tick. */
  start(): void;
  /** Stops timers, closes sockets (1001) and tears live view down. */
  stop(): Promise<void>;
}

/** Builds the hub, live view and feed wiring. */
export function createRealtimeHub(deps: CreateRealtimeHubDeps): Realtime {
  const liveView = new LiveView({
    sessions: deps.sessions,
    bridges: deps.bridges,
    pageOf: deps.pageOf,
    logger: deps.logger,
    schedule: deps.schedule,
    ...(deps.quality !== undefined && { quality: deps.quality }),
    ...(deps.graceMs !== undefined && { graceMs: deps.graceMs }),
    ...(deps.onOperatorPointer !== undefined && { onOperatorPointer: deps.onOperatorPointer }),
    ...(deps.onViewportChanged !== undefined && { onViewportChanged: deps.onViewportChanged }),
  });
  const hub = new RealtimeHub({ ...deps, liveView });
  const stops: (() => void)[] = [];
  return {
    hub,
    liveView,
    websocket: websocketHandler(hub, deps.logger),
    start() {
      stops.push(
        wireFeed({
          bus: deps.bus,
          target: hub,
          logger: deps.logger,
          schedule: deps.schedule,
          ...(deps.logs !== undefined && { logs: deps.logs }),
          onSessionClosed: (id, crashed) => void liveView.sessionClosed(id, crashed),
        }),
        deps.every(() => hub.sweep(), SWEEP_INTERVAL_MS),
        deps.every(
          () => hub.publish('system', { type: 'system.tick', now: deps.clock.now() }),
          30_000,
        ),
      );
    },
    async stop() {
      for (const stop of stops.splice(0)) stop();
      hub.dispose();
      await liveView.dispose();
    },
  };
}
