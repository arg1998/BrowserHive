/** @module domain/site-packs/text-safety — pack strings must be plain text (spec 13 §9.10 "rendered as text only"): no C0/C1 control characters (terminal escapes such as ANSI colours or OSC 8 links), no Unicode format characters (bidi overrides and isolates, zero-width marks) and no line or paragraph separators, in any string value or record key of a pack. */

/** One refused string (the shape of `refine.ts` `PackIssue`). */
export interface TextIssue {
  readonly path: string;
  readonly message: string;
}

/** Controls (`Cc`), format characters (`Cf`: bidi controls, ZWJ/ZWNJ, BOM) and `Zl`/`Zp` separators. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** `U+202E` for a message: the code point of the first unsafe character. */
function codePointOf(value: string): string {
  const found = UNSAFE.exec(value)?.[0] ?? '';
  const code = found.codePointAt(0) ?? 0;
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Every string in `value` (a parsed pack) holding an unsafe character, by JSON path. */
export function unsafeTextIssues(value: unknown, path = ''): TextIssue[] {
  if (typeof value === 'string') {
    return UNSAFE.test(value)
      ? [
          {
            path,
            message: `contains a control or invisible formatting character (${codePointOf(value)}); pack text must be plain`,
          },
        ]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => unsafeTextIssues(item, `${path}[${i}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => {
      const at = path === '' ? key : `${path}.${key}`;
      const keyIssue = unsafeTextIssues(key, `${at} (key)`);
      return [...keyIssue, ...unsafeTextIssues(item, at)];
    });
  }
  return [];
}
