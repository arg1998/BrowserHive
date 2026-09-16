/** @module infra/browsers/native-getter — the one context init script that installs masked "native" getters (display fingerprint + deviceMemory fallback; spec 11 §2.4). */

/**
 * The display fingerprint and the deviceMemory fallback share one init script with a single shared
 * helper and a single `Function.prototype.toString` proxy. Two scripts that each replaced `toString`
 * with their own Proxy would leave one proxy wrapping the other, which is itself detectable. Because an init script is **serialised** by Playwright
 * (`fn.toString()` is shipped to the page), the helper cannot be an import — it *is* the script,
 * and the fingerprint and identity modules only build its payload.
 */

// The page globals the script touches. Core compiles without the DOM lib (it is a server package),
// so the two names the script needs are declared here with the narrowest shape it uses.
declare const Screen: { readonly prototype: object };
declare const window: object;

/** The `screen` metrics presented to the page. Mirrors the real `Screen` interface Chrome exposes. */
export interface ScreenMetrics {
  readonly width: number;
  readonly height: number;
  readonly availWidth: number;
  readonly availHeight: number;
  /** Non-standard but present in Chrome; the OS bar offset (macOS menu bar). */
  readonly availTop: number;
  /** Non-standard but present in Chrome. */
  readonly availLeft: number;
}

/** The `window` outer-geometry metrics presented to the page. */
export interface WindowMetrics {
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly screenX: number;
  readonly screenY: number;
}

/** What the init script installs. Kept minimal and JSON-plain — it is serialised into the page. */
export interface NativeGetterPayload {
  /** `Screen.prototype` getters; absent when the display is not asserted. */
  readonly screen?: ScreenMetrics;
  /** `window` instance getters (+ `screenLeft`/`screenTop` mirrors); absent with `screen`. */
  readonly window?: WindowMetrics;
  /** `navigator.deviceMemory` to present **only if the browser reports none**. */
  readonly deviceMemoryFallback?: number;
}

/** Merge partial payloads (fingerprint + identity) into the one script argument. */
export function mergeNativeGetterPayloads(
  ...parts: readonly (NativeGetterPayload | undefined)[]
): NativeGetterPayload {
  let merged: NativeGetterPayload = {};
  for (const part of parts) if (part !== undefined) merged = { ...merged, ...part };
  return merged;
}

/**
 * Init-script body, injected via `context.addInitScript(installNativeGetters, payload)` so it runs
 * before any page script, on every document and frame, in every tab the context ever opens.
 *
 * **It must not close over anything** — it is serialised and evaluated in the page, so the payload
 * arrives as the `fp` argument and every helper is defined inline.
 *
 * ### Why the `toString` redirect is not optional
 *
 * A page can ask how a property is implemented:
 * `Object.getOwnPropertyDescriptor(Screen.prototype, 'width').get.toString()`. Natively that returns
 * `"function get width() { [native code] }"`; a plain replacement getter returns its own source, which
 * is a *louder* signal than the wrong screen size we set out to fix — we would be trading a weak tell
 * for a decisive one. So `Function.prototype.toString` is proxied to report `[native code]` for the
 * getters we install (and for the proxy itself, or it would expose its own replacement). Verified
 * against a real browser: every descriptor below reads byte-identically to an untouched one, and
 * `Function.prototype.toString.call(undefined)` still throws `TypeError` as it must.
 *
 * This technique is well known to detector authors, so treat it as raising the cost of detection, not
 * as invisibility. It is strictly better than both alternatives (a naive getter, or leaving a
 * fleet-wide 1280x720 in place).
 *
 * ### Why only these properties
 *
 * Everything reachable natively is set natively instead — `viewport`/`deviceScaleFactor` via context
 * options, UA/UA-CH/`Accept-Language`/`navigator.languages` via one CDP call. What remains here is
 * exactly the set with no native mechanism. `deviceMemory` is applied **only when the browser reports
 * none**: the full binary already reports a real value, and replacing a true value with an invented
 * one would be a downgrade.
 */
export function installNativeGetters(fp: NativeGetterPayload): void {
  // `[native code]` masking for every getter we install, keyed by identity so nothing else is
  // affected. A WeakMap keeps the registry invisible to enumeration.
  const nativeToString = Function.prototype.toString;
  const masked = new WeakMap<object, string>();
  const toStringProxy = new Proxy(nativeToString, {
    apply(target, thisArg, args: unknown[]) {
      const label = thisArg === null || thisArg === undefined ? undefined : masked.get(thisArg);
      if (label !== undefined) return `function ${label}() { [native code] }`;
      return Reflect.apply(target, thisArg, args);
    },
  });
  masked.set(toStringProxy, 'toString');
  // Redefine rather than assign: `Function.prototype.toString` is writable, but `defineProperty`
  // preserves the original attributes (non-enumerable) instead of creating an enumerable own prop.
  Object.defineProperty(Function.prototype, 'toString', { value: toStringProxy });

  const define = (target: object, prop: string, value: unknown): void => {
    const getter = (): unknown => value;
    const label = `get ${prop}`;
    masked.set(getter, label);
    try {
      // A native accessor's function name is `get width`, not the `getter` JavaScript would infer
      // from this binding. Leaving it inferred would defeat the whole point of the `toString` mask:
      // `descriptor.get.name` is the same one-line probe, one property along.
      Object.defineProperty(getter, 'name', { value: label, configurable: true });
      // `enumerable: true` matches the real accessors on these interfaces (verified against an
      // untouched `Navigator.prototype.hardwareConcurrency`).
      Object.defineProperty(target, prop, { get: getter, configurable: true, enumerable: true });
    } catch {
      // Non-configurable in this engine: keep the native value rather than throwing inside a page.
    }
  };

  if (fp.screen !== undefined) {
    for (const [prop, value] of Object.entries(fp.screen)) define(Screen.prototype, prop, value);
  }
  if (fp.window !== undefined) {
    // `outerWidth`/`outerHeight`/`screenX`/`screenY` resolve on the window instance, not
    // `Window.prototype` — defining them on the prototype is silently shadowed (verified).
    for (const [prop, value] of Object.entries(fp.window)) define(window, prop, value);
    // Chromium exposes the window's position twice, under two names. Overriding only `screenX`/
    // `screenY` leaves `screenLeft`/`screenTop` reporting the real values, so `screenX !== screenLeft`
    // becomes a one-line self-contradiction — a stronger signal than the geometry this fixes.
    define(window, 'screenLeft', fp.window.screenX);
    define(window, 'screenTop', fp.window.screenY);
  }

  if (fp.deviceMemoryFallback !== undefined) {
    const nav: Navigator & { deviceMemory?: number } = navigator;
    if (nav.deviceMemory === undefined || nav.deviceMemory === 0) {
      define(Navigator.prototype, 'deviceMemory', fp.deviceMemoryFallback);
    }
  }
}
