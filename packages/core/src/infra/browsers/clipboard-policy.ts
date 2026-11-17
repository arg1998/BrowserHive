/** @module infra/browsers/clipboard-policy — a template's "Deny clipboard writes" switch on its browser (spec 13 §2.1, §13 "The operator's desktop"; D18): the `clipboard-write` permission denied for the context, and, through a main-world init script, `document.execCommand('copy' | 'cut')` refused and the page's `copy`/`cut` listeners kept from rewriting a person's own copy, which the permission does not cover. A change while the browser runs reaches every open document at once, but only a start gives full effect: a document open at the change keeps whatever it took before (`needsRestart`). */

import type { BrowserContext, CDPSession, Disposable } from 'patchright';
import type { Logger } from '../../ports/logger.ts';
import { patchOpenDocuments } from './clipboard-frames.ts';

// Core compiles without the DOM lib; the page globals the init script touches.
declare const Document: { readonly prototype: object };
declare const Event: { readonly prototype: { readonly stopImmediatePropagation: unknown } };
declare const window: {
  addEventListener(type: string, listener: (event: object) => void, capture: boolean): void;
};

/**
 * The permission descriptors denied while the switch is on: sanitized writes
 * (`navigator.clipboard.writeText`/`write`) and unsanitized ones. Measured on Chromium 153: a
 * denial makes both calls reject with `NotAllowedError` after a real click, whatever the arguments
 * (a lying `toString`, getters, a `Proxy` of items: the check is the browser's, before any of them
 * is read), but leaves `execCommand('copy')` working, hence {@link blockPageClipboardWrites}.
 */
const DENIED = [
  { name: 'clipboard-write' },
  { name: 'clipboard-write', allowWithoutSanitization: true },
] as const;

/**
 * Init-script body, the writes the permission does not cover:
 *
 * - `document.execCommand('copy' | 'cut')` returns `false` and does nothing; every other command
 *   is untouched. A `Proxy` keeps the method's name and length and has no `prototype`.
 * - The page's own `copy` and `cut` listeners never run (a capturing listener on `window`, added
 *   before any page script, stops the event), so a person's Ctrl/Cmd+C copies what they selected:
 *   the page cannot replace it with `clipboardData.setData` (measured: without this, a lingering
 *   `copy` listener rewrote a keyboard copy).
 *
 * Nothing a page can reach is consulted when a call happens (review #84 H1): the command is
 * coerced to a string once and that string is what the native method gets (a `toString` that
 * answers `bold` first and `copy` second cannot pass); `String`, `toLowerCase`, `Reflect.apply`
 * and `stopImmediatePropagation` are taken before page scripts run (a page that replaces them later
 * changes nothing and never receives the native method); the trap object has no prototype (an
 * `Object.prototype.get` would otherwise be called with the native method as its target); the
 * forwarded arguments are an array literal (no setter on `Array.prototype` is involved).
 *
 * It must not close over anything (it is serialised into the page) and runs in the main world, in
 * every document and frame, before page scripts. Both are detectable, as is the denied permission
 * (`navigator.permissions.query`): the switch is the operator's opt-in (D18).
 */
export function blockPageClipboardWrites(): void {
  const apply = Reflect.apply;
  const toText = String;
  const lower = String.prototype.toLowerCase;
  const stopNow = Event.prototype.stopImmediatePropagation;
  const proto = Document.prototype as { execCommand?: unknown };
  const original = proto.execCommand;
  if (typeof original === 'function') {
    const blocked = new Proxy(original, {
      __proto__: null,
      apply(target: (...args: unknown[]) => unknown, thisArg: unknown, args: unknown[]): unknown {
        const command = toText(args[0]);
        const name = apply(lower, command, []);
        if (name === 'copy' || name === 'cut') return false;
        return apply(target, thisArg, args.length > 1 ? [command, args[1], args[2]] : [command]);
      },
    } as ProxyHandler<(...args: unknown[]) => unknown>);
    Object.defineProperty(proto, 'execCommand', {
      value: blocked,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const stop = (event: object): void => {
    apply(stopNow as (this: object) => void, event, []);
  };
  window.addEventListener('copy', stop, true);
  window.addEventListener('cut', stop, true);
}

/** Who asks: the host start (before any agent page) or an operator's change on a running browser. */
export type ClipboardApplyAt = 'start' | 'live';

/** The policy of one browser context; at most one per context ({@link applyClipboardPolicy}). */
class ClipboardPolicy {
  readonly #context: BrowserContext;
  readonly #log: Logger;
  #deny = false;
  /** A live change took effect: documents open at that moment keep their old state until a start. */
  #changedLive = false;
  #script: Disposable | null = null;
  #contextId: string | null = null;
  #cdp: CDPSession | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(context: BrowserContext, logger: Logger) {
    this.#context = context;
    this.#log = logger;
  }

  get needsRestart(): boolean {
    return this.#changedLive;
  }

  /** Applies `deny`; calls run one at a time, in order. */
  set(deny: boolean, at: ClipboardApplyAt): Promise<void> {
    const next = this.#queue.then(() => this.#apply(deny, at));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #apply(deny: boolean, at: ClipboardApplyAt): Promise<void> {
    if (deny === this.#deny) return;
    if (deny) {
      await this.#permissions(true);
      this.#script = await this.#context.addInitScript(blockPageClipboardWrites);
      const reached = await patchOpenDocuments(
        this.#context,
        blockPageClipboardWrites.toString(),
        this.#log,
      );
      if (reached.missed > 0) this.#log.warn('clipboard patch partial', { ...reached });
    } else {
      await this.#permissions(false);
      // Documents loaded from now on are untouched; open ones keep the script part (`execCommand`
      // copy/cut refused, page copy listeners stopped) until they reload: a page could reach
      // anything that lifts it.
      await this.#script?.dispose();
      this.#script = null;
    }
    this.#deny = deny;
    if (at === 'live') this.#changedLive = true;
    this.#log.info('clipboard writes', { denied: deny, at });
  }

  /**
   * Denies the permission for the host's context, or lifts the denial. `Browser.resetPermissions`
   * clears every override of the context: the host sets no other (spec 13 §3.1).
   */
  async #permissions(deny: boolean): Promise<void> {
    const browserContextId = await this.#browserContextId();
    const cdp = await this.#browserSession();
    if (deny) {
      for (const permission of DENIED) {
        await cdp.send('Browser.setPermission', {
          permission,
          setting: 'denied',
          browserContextId,
        });
      }
    } else {
      await cdp.send('Browser.resetPermissions', { browserContextId });
    }
  }

  /**
   * The policy's own browser-level session, kept for the browser's life: Chromium drops the
   * permission overrides a DevTools session set when that session detaches (measured).
   */
  async #browserSession(): Promise<CDPSession> {
    if (this.#cdp !== null) return this.#cdp;
    const browser = this.#context.browser();
    if (browser === null) throw new Error('the template browser has no browser-level session');
    this.#cdp = await browser.newBrowserCDPSession();
    return this.#cdp;
  }

  /** The context's id from any open page's target info (as `HostTargets.open` reads it). */
  async #browserContextId(): Promise<string> {
    if (this.#contextId !== null) return this.#contextId;
    const page = this.#context.pages().find((p) => !p.isClosed());
    if (page === undefined) throw new Error('the template browser has no open page');
    const cdp = await this.#context.newCDPSession(page);
    try {
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      if (targetInfo.browserContextId === undefined) throw new Error('no browserContextId');
      this.#contextId = targetInfo.browserContextId;
      return this.#contextId;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }
}

const POLICIES = new WeakMap<BrowserContext, ClipboardPolicy>();

/**
 * Applies a template's "Deny clipboard writes" switch to its browser context: at host start
 * (`at: 'start'`), and live when an operator changes it (no restart). Off is the browser's own
 * behaviour, so a host started with the switch off is not touched.
 *
 * Live, turning it on reaches every open document, frames included, but a document open at that
 * moment may hold what it took earlier (a reference to the native `execCommand`, its own capturing
 * `copy` listener, replaced built-ins): only documents loaded afterwards are fully covered. Turning
 * it off lifts the permission at once; open documents keep refusing `execCommand` copy/cut until
 * they reload. Either way {@link clipboardNeedsRestart} is then true.
 *
 * @throws When the permission cannot be set; a host start then fails (the switch is a protection).
 */
export async function applyClipboardPolicy(
  context: BrowserContext,
  deny: boolean,
  logger: Logger,
  at: ClipboardApplyAt = 'live',
): Promise<void> {
  let policy = POLICIES.get(context);
  if (policy === undefined) {
    if (!deny) return;
    policy = new ClipboardPolicy(context, logger.child({ module: 'browsers.clipboard' }));
    POLICIES.set(context, policy);
  }
  await policy.set(deny, at);
}

/**
 * True when the switch changed while this browser ran: documents open at the change keep their old
 * state, so only a restart gives the switch full effect.
 */
export function clipboardNeedsRestart(context: BrowserContext): boolean {
  return POLICIES.get(context)?.needsRestart ?? false;
}
