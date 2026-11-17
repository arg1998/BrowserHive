/** @module cli/output/printable — keeps text that came from elsewhere (site packs, server messages) from driving the terminal: control characters (C0, DEL, C1, so ANSI and OSC sequences) and Unicode format characters (bidi overrides and isolates, zero-width marks) become U+FFFD before the text is printed */

/** Control (`Cc`) and format (`Cf`) characters: ESC, BEL, CR, the bidi controls, zero-width marks. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;

/** What an unprintable character is shown as. */
const REPLACEMENT = '�';

/**
 * One string, safe to print: every control or format character is replaced by U+FFFD, so it
 * can neither move, recolour nor reorder the text around it.
 *
 * @returns The text.
 */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, REPLACEMENT);
}

/**
 * {@link printable} over every string of parsed JSON (keys too), before it is validated and
 * printed; other values are returned as they are.
 *
 * @returns The same shape with printable strings.
 */
export function printableJson(value: unknown): unknown {
  if (typeof value === 'string') return printable(value);
  if (Array.isArray(value)) return value.map(printableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [printable(key), printableJson(item)]),
    );
  }
  return value;
}
