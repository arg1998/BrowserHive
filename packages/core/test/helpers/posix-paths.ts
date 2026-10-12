/** @module test/helpers/posix-paths — compare host paths with the POSIX paths a suite states: identity on POSIX, `C:\a\b` and `\a\b` become `/a/b` on Windows. */

/**
 * The suites state paths POSIX-style (`/data/sessions/x`). On Windows production code builds them
 * with `node:path` (`\data\sessions\x`, or `C:\data\…` once resolved), which is right there; this
 * maps them back so one expectation covers both. The identity on every other platform.
 */
export function posixPath(path: string, platform: string = process.platform): string {
  if (platform !== 'win32') return path;
  // `\\` too: JSON escapes each separator.
  return path.replace(/^[A-Za-z]:(?=[\\/])/, '').replace(/\\\\|\\/g, '/');
}

/**
 * A Windows path inside a text: optional drive, then a separator (`\`, or `\\` in JSON) followed by a
 * path character. A backslash before anything else (`\{` in a pattern) is left alone.
 */
const WINDOWS_PATH_IN_TEXT = /(?:\b[A-Za-z]:)?(?:\\\\|\\)(?=[\w.-])[^\s'"#,;)]*/g;

/** {@link posixPath} for every Windows path inside a text. */
export function posixPathsIn(text: string, platform: string = process.platform): string {
  if (platform !== 'win32') return text;
  return text.replace(WINDOWS_PATH_IN_TEXT, (path) => posixPath(path, platform));
}

/** {@link posixPathsIn} over every string of plain data (arrays and plain objects, recursively). */
export function posixView<T>(value: T): T {
  if (process.platform !== 'win32') return value;
  if (typeof value === 'string') return posixPathsIn(value) as T;
  if (Array.isArray(value)) return value.map((v) => posixView(v)) as T;
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, posixView(v)])) as T;
  }
  return value;
}
