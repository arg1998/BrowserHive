/** @module infra/browsers/missing-binary — the driver's launch-time prose for a missing binary or branded distribution, shared by the resolver, the sandbox probe and the error classifier (Patchright keeps Playwright's texts). */

/**
 * Matches every launch failure that means "this browser is not installed"; `channel` names the
 * missing branded distribution when the driver says which. Patchright 1.63 writes "Looks like
 * Playwright was just installed or updated"; older Playwright wrote "Playwright Test or Playwright".
 */
export const MISSING_BINARY_RE =
  /Executable doesn't exist at|Chromium distribution '(?<channel>[\w-]+)' is not found|Failed to launch: .*ENOENT|Looks like Playwright( Test or Playwright)? was just installed or updated/;
