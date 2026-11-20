/** @module infra/browsers/storage-state-page — the page Playwright opens to read or write the storage of origins no open page shows (a checkpoint, a restore; spec 13 §3.9, D-78): on a headed template host it is created as a minimized background window, never as a foreground tab that takes the focus; and on every host its unawaited interception setup is kept from surfacing as an unhandled rejection when the page closes first. */

import type { BrowserContext } from 'patchright';
import type { Logger } from '../../ports/logger.ts';
import { serverObjectOf } from './driver-preflights.ts';
import { driverCoreVersion, isVerifiedDriverVersion } from './preflight-enforcement.ts';
import { field, isRecord } from './preflight-relay.ts';

/**
 * The problem (measured, Patchright 1.63 on Chromium 153 and Chrome 154, Xvfb with a window
 * manager; spec 13 §3.9, D-78). `context.storageState()` collects localStorage and IndexedDB
 * from the open pages, and for every origin of this browser process that no page shows it opens a
 * page of its own (`BrowserContext.newPage(progress, forStorageState)` →
 * `CRBrowserContext.doCreateNewPage` → `Target.createTarget {url: 'about:blank'}`), which Chromium
 * opens as a **foreground tab** in the last active window: an agent window is raised, its visible
 * tab switches, and the operator's focus moves to it (3 of 3 runs), at every checkpoint (15 min)
 * and clean stop. `setStorageState` (restore, seed) does the same.
 *
 * The fix. On each headed host's server-side context, `doCreateNewPage` is wrapped: while the
 * context is creating its storage-state page (`isCreatingStorageStatePage()`), the target is
 * created with `newWindow: true, background: true, windowState: 'minimized'` (a minimized
 * background window: Chromium never activates it), and the page is taken from the browser's
 * `_crPages` exactly as the original does. Every other page creation runs the original. Playwright
 * skips its window sizing for that page (`isStorageStatePage`), so nothing restores the window.
 *
 * Driver internals read (re-check on every Patchright bump; pinned by
 * `test/integration/template-no-window.test.ts`): `BrowserContext._connection.toImpl`, the server
 * context's `doCreateNewPage`, `isCreatingStorageStatePage`, `_browserContextId`, and its browser's
 * `_session.send` and `_crPages`. On any other driver version, or another shape, nothing is wrapped
 * and the checkpoint keeps the driver's foreground tab (logged once per host as a warning).
 */

/** What the verified `doCreateNewPage` source contains. */
export const STORAGE_PAGE_MARKERS: readonly string[] = Object.freeze([
  'Target.createTarget',
  '_crPages',
  'browserContextId',
]);

/** Marks a wrapped server context. */
const WRAPPED = Symbol.for('browserhive.backgroundStorageStatePages');

type Fn = (...args: unknown[]) => unknown;

/** A server-side CDP session with `send`. */
interface ServerSession {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
}

function isServerSession(value: unknown): value is ServerSession {
  return isRecord(value) && typeof value['send'] === 'function';
}

/**
 * Wraps the storage-state page creation of `context` (see the module doc).
 *
 * @returns Whether the context is (now) wrapped.
 */
export function backgroundStorageStatePages(context: BrowserContext, log: Logger): boolean {
  const refuse = (reason: string): boolean => {
    // Checkpoints keep the driver's foreground tab for origins no page shows.
    log.warn('storage page not wrapped', { reason });
    return false;
  };
  if (!isVerifiedDriverVersion(driverCoreVersion())) return refuse('driver_version');
  const server = serverObjectOf(context);
  if (server === null || !isRecord(server)) return refuse('driver_connection');
  if (Reflect.get(server, WRAPPED) === true) return true;
  const original = field(server, 'doCreateNewPage');
  const creating = field(server, 'isCreatingStorageStatePage');
  const browser = field(server, '_browser');
  const session = field(browser, '_session');
  const crPages = field(browser, '_crPages');
  if (
    typeof original !== 'function' ||
    typeof creating !== 'function' ||
    !isServerSession(session) ||
    !(crPages instanceof Map) ||
    !STORAGE_PAGE_MARKERS.every((marker) =>
      Function.prototype.toString.call(original).includes(marker),
    )
  ) {
    return refuse('driver_shape');
  }
  const browserContextId: unknown = field(server, '_browserContextId');
  const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    if (Reflect.apply(creating as Fn, server, []) !== true) {
      return Reflect.apply(original as Fn, this, args);
    }
    const params: Record<string, unknown> = {
      url: 'about:blank',
      newWindow: true,
      background: true,
      ...(typeof browserContextId === 'string' && { browserContextId }),
    };
    let created: unknown;
    try {
      created = await session.send('Target.createTarget', { ...params, windowState: 'minimized' });
    } catch {
      // An older Chromium refuses `windowState` here: still a background window.
      created = await session.send('Target.createTarget', params);
    }
    const targetId = field(created, 'targetId');
    const page = field(typeof targetId === 'string' ? crPages.get(targetId) : undefined, '_page');
    if (page === undefined) throw new Error('storage state page not attached');
    return page;
  };
  Object.defineProperty(server, 'doCreateNewPage', {
    value: wrapped,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(server, WRAPPED, { value: true });
  return true;
}

/** Marks a `CRNetworkManager` prototype whose storage-page calls are quieted. */
const QUIETED = Symbol.for('browserhive.quietStoragePageInterception');

/**
 * The race (measured on Patchright 1.63, Chromium 153: 1 in 2 clean stops of a host with no page
 * left). Patchright's `CRPage` constructor calls `this._networkManager.setRequestInterception(true)`
 * without awaiting or catching it. A storage-state page lives for a few milliseconds when it visits
 * one origin, so its session can close before that call's `Network.setCacheDisabled` is sent: the
 * promise rejects with nobody listening, which the daemon reports as `UNHANDLED`.
 *
 * The wrap. On the shared `CRNetworkManager` prototype (found through the first page of the
 * context), `setRequestInterception` gets a no-op `catch` attached to its promise when the page is a
 * storage-state page (`isStorageStatePage`). The same promise is returned, so a caller that awaits
 * it still sees its outcome; only the dangling constructor call stops being unhandled.
 */
export function quietStoragePageInterception(context: BrowserContext): void {
  if (!isVerifiedDriverVersion(driverCoreVersion())) return;
  const server = serverObjectOf(context);
  const pages = field(server, 'pages');
  const on = field(server, 'on');
  const off = field(server, 'off');
  if (typeof pages !== 'function' || typeof on !== 'function') return;
  const existing: unknown = Reflect.apply(pages, server, []);
  if (Array.isArray(existing) && existing.some((page) => quietFrom(page))) return;
  const onPage = (page: unknown): void => {
    if (quietFrom(page) && typeof off === 'function') {
      Reflect.apply(off, server, ['page', onPage]);
    }
  };
  Reflect.apply(on, server, ['page', onPage]);
}

/** Wraps the prototype of `serverPage`'s network manager; true once it is wrapped. */
function quietFrom(serverPage: unknown): boolean {
  const manager = field(field(serverPage, 'delegate'), '_networkManager');
  if (!isRecord(manager)) return false;
  const proto: unknown = Object.getPrototypeOf(manager);
  if (!isRecord(proto)) return false;
  if (Reflect.get(proto, QUIETED) === true) return true;
  const original = proto['setRequestInterception'];
  if (typeof original !== 'function') return false;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const result: unknown = Reflect.apply(original as Fn, this, args);
    if (field(field(this, '_page'), 'isStorageStatePage') === true && result instanceof Promise) {
      result.catch(() => undefined);
    }
    return result;
  };
  Object.defineProperty(proto, 'setRequestInterception', {
    value: wrapped,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(proto, QUIETED, { value: true });
  return true;
}
