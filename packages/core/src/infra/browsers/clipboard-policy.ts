/** @module infra/browsers/clipboard-policy — a template's "Deny clipboard writes" switch on its browser (spec 13 §2.1, §13 "The operator's desktop"; D18): the `clipboard-write` permission denied for the context, and, through a main-world init script, `document.execCommand('copy' | 'cut')` refused and the page's `copy`/`cut` listeners kept from rewriting a person's own copy, which the permission does not cover. */

import type { BrowserContext, CDPSession, Disposable } from 'patchright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';

// Core compiles without the DOM lib; the page globals the init script touches.
declare const Document: { readonly prototype: object };
declare const window: {
  addEventListener(
    type: string,
    listener: (event: { stopImmediatePropagation(): void }) => void,
    capture: boolean,
  ): void;
};

/**
 * The permission descriptors denied while the switch is on: sanitized writes
 * (`navigator.clipboard.writeText`/`write`) and unsanitized ones. Measured on Chromium 153: a
 * denial makes both calls reject with `NotAllowedError` after a real click, but leaves
 * `execCommand('copy')` working, hence {@link blockPageClipboardWrites}.
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
 * It must not close over anything (it is serialised into the page) and runs in the main world, in
 * every document and frame, before page scripts. Both are detectable, as is the denied permission
 * (`navigator.permissions.query`): the switch is the operator's opt-in (D18).
 */
export function blockPageClipboardWrites(): void {
  const proto = Document.prototype as { execCommand?: unknown };
  const original = proto.execCommand;
  if (typeof original === 'function') {
    const blocked = new Proxy(original, {
      apply(target, thisArg: unknown, args: unknown[]) {
        const command = String(args[0]).toLowerCase();
        if (command === 'copy' || command === 'cut') return false;
        return Reflect.apply(target, thisArg, args);
      },
    });
    Object.defineProperty(proto, 'execCommand', {
      value: blocked,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const stop = (event: { stopImmediatePropagation(): void }) => event.stopImmediatePropagation();
  window.addEventListener('copy', stop, true);
  window.addEventListener('cut', stop, true);
}

/** The policy of one browser context; at most one per context ({@link applyClipboardPolicy}). */
class ClipboardPolicy {
  readonly #context: BrowserContext;
  readonly #log: Logger;
  #deny = false;
  #script: Disposable | null = null;
  #contextId: string | null = null;
  #cdp: CDPSession | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(context: BrowserContext, logger: Logger) {
    this.#context = context;
    this.#log = logger;
  }

  /** Applies `deny`; calls run one at a time, in order. */
  set(deny: boolean): Promise<void> {
    const next = this.#queue.then(() => this.#apply(deny));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #apply(deny: boolean): Promise<void> {
    if (deny === this.#deny) return;
    if (deny) {
      await this.#permissions(true);
      this.#script = await this.#context.addInitScript(blockPageClipboardWrites);
      await this.#patchOpenDocuments();
    } else {
      await this.#permissions(false);
      // Documents loaded from now on are untouched; open ones keep the patch until they reload.
      await this.#script?.dispose();
      this.#script = null;
    }
    this.#deny = deny;
    this.#log.info('clipboard writes', { denied: deny });
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

  /**
   * Patches the main frame of every open page, so the switch applies at once. `Runtime.evaluate`
   * without a user gesture (Playwright's `evaluate` would give the page user activation). Frames
   * already loaded inside a page are patched when they next load a document.
   */
  async #patchOpenDocuments(): Promise<void> {
    const expression = `(${blockPageClipboardWrites.toString()})()`;
    for (const page of this.#context.pages()) {
      if (page.isClosed()) continue;
      try {
        const cdp = await this.#context.newCDPSession(page);
        try {
          await cdp.send('Runtime.evaluate', { expression, userGesture: false, silent: true });
        } finally {
          await cdp.detach().catch(() => undefined);
        }
      } catch (err) {
        // A page closing meanwhile; its next document gets the init script anyway.
        this.#log.debug('clipboard patch skipped', { err: serializeError(err) });
      }
    }
  }
}

const POLICIES = new WeakMap<BrowserContext, ClipboardPolicy>();

/**
 * Applies a template's "Deny clipboard writes" switch to its browser context: at host start, and
 * live when an operator changes it (no restart). Off is the browser's own behaviour, so a host
 * started with the switch off is not touched.
 *
 * @throws When the permission cannot be set; a host start then fails (the switch is a protection).
 */
export async function applyClipboardPolicy(
  context: BrowserContext,
  deny: boolean,
  logger: Logger,
): Promise<void> {
  let policy = POLICIES.get(context);
  if (policy === undefined) {
    if (!deny) return;
    policy = new ClipboardPolicy(context, logger.child({ module: 'browsers.clipboard' }));
    POLICIES.set(context, policy);
  }
  await policy.set(deny);
}
