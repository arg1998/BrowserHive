/** @module ports/page-types — the page-level Playwright types `interface/` modules may name; `BrowserContext` is deliberately absent (spec 13 §3.13, dependency-cruiser rule `interface-no-playwright`). */

/**
 * Playwright's page-scoped types, re-exported type-only. `interface/` reaches a session's browser
 * only through its `SessionView`, so it never needs (and, by the dependency-cruiser rule, never
 * imports) `BrowserContext` or `Browser`.
 */
export type { CDPSession, Dialog, Download, Page, Response } from 'playwright';
