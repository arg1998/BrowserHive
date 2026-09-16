/** @module app/shell/platform — platform facts for shortcut labels (⌘ on macOS-like, Ctrl elsewhere) */

/** Is this a macOS-like platform (for ⌘ labels)? */
export function isMacLike(
  nav:
    | { readonly platform?: string; readonly userAgent?: string }
    | undefined = globalThis.navigator,
): boolean {
  if (nav === undefined) return false;
  return /mac|iphone|ipad/i.test(nav.platform || nav.userAgent || '');
}
