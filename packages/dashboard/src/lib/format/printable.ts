/** @module lib/format/printable — text that came from elsewhere (site packs, the registry's signed index, server messages) made safe to show: control (`Cc`), format (`Cf`, the bidi overrides and isolates, zero-width marks), line and paragraph separator (`Zl`, `Zp`) characters become U+FFFD, so they can neither reorder, hide nor restyle the text around them (spec 13 §9.10; review #100 H1). The dashboard's twin of the CLI's `cli/output/printable` */

/** Every control, format, line- or paragraph-separator character. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** The same, sparing the line feed (multi-line plain text such as a publisher's notes). */
const UNPRINTABLE_KEEP_LF = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** What an unprintable character is shown as. */
export const REPLACEMENT = '�';

/** `text` with every unprintable character replaced by U+FFFD; `multiline` keeps line feeds. */
export function printable(text: string, options: { readonly multiline?: boolean } = {}): string {
  return text.replace(options.multiline === true ? UNPRINTABLE_KEEP_LF : UNPRINTABLE, REPLACEMENT);
}

/**
 * Printable text isolated for a plain-text surface (toasts, dialog copy, labels): wrapped in FIRST
 * STRONG ISOLATE / POP DIRECTIONAL ISOLATE so its direction cannot leak into the text around it.
 */
export function isolated(text: string): string {
  return `⁨${printable(text)}⁩`;
}
