/** @module infra/browsers/classify-error.test — Playwright prose → registry code fixture table. */

import { describe, expect, it } from 'bun:test';
import type { ErrorCode } from '@browserhive/contracts/errors';
import { AppError } from '../../kernel/errors/app-error.ts';
import {
  type ClassifyContext,
  classifyDriverError,
  isActionabilityError,
  isTargetClosedError,
} from './classify-error.ts';

/** One row per table entry: the Playwright prose fixture, the context, the expected code + details. */
const FIXTURES: readonly {
  readonly name: string;
  readonly message: string;
  readonly errorName?: string;
  readonly ctx?: ClassifyContext;
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
}[] = [
  {
    name: 'missing bundled chromium',
    message:
      "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1243/chrome-linux/chrome\n╔═══╗\n║ Looks like Playwright Test or Playwright was just installed or updated. ║",
    ctx: { channel: 'chromium' },
    code: 'BROWSER_NOT_INSTALLED',
    details: { channel: 'chromium', install_command: 'browserhive init' },
  },
  {
    name: 'missing branded distribution',
    message:
      "browserType.launch: Chromium distribution 'msedge' is not found at /opt/microsoft/msedge",
    code: 'BROWSER_NOT_INSTALLED',
    details: { channel: 'msedge', install_command: 'browserhive init' },
  },
  {
    name: 'target closed with a tab',
    message: 'page.click: Target page, context or browser has been closed',
    ctx: { tabId: 't-abc123', selector: '#x' },
    code: 'PAGE_CLOSED',
    details: { tab_id: 't-abc123' },
  },
  {
    name: 'target closed without a tab',
    message: 'browser.newContext: Target closed',
    ctx: { sessionId: 'sess-1' },
    code: 'BROWSER_CRASHED',
    details: { session_id: 'sess-1' },
  },
  {
    name: 'strict mode violation',
    message:
      "locator.click: Error: strict mode violation: locator('button') resolved to 3 elements:\n    1) <button>a</button>",
    ctx: { selector: 'button' },
    code: 'ELEMENT_NOT_FOUND',
    details: { selector: 'button', count: 3 },
  },
  {
    name: 'navigation timeout',
    message:
      'page.goto: Timeout 30000ms exceeded.\n=========================== logs ===========================\nnavigating to "https://example.com/", waiting until "load"',
    errorName: 'TimeoutError',
    ctx: { url: 'https://example.com/' },
    code: 'NAVIGATION_TIMEOUT',
    details: { url: 'https://example.com/', timeout_ms: 30000 },
  },
  {
    name: 'navigation net error',
    message: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/',
    ctx: { url: 'https://nope.invalid/' },
    code: 'NAVIGATION_FAILED',
    details: { url: 'https://nope.invalid/', net_error: 'net::ERR_NAME_NOT_RESOLVED' },
  },
  {
    name: 'download canceled',
    message: 'download.path: canceled',
    code: 'DOWNLOAD_FAILED',
    details: { reason: 'canceled' },
  },
  {
    name: 'download deleted on close',
    message: 'Download deleted upon browser context closure.',
    code: 'DOWNLOAD_FAILED',
    details: { reason: 'deleted upon browser context closure.' },
  },
  {
    name: 'upload failed',
    message: "locator.setInputFiles: Error: ENOENT: no such file or directory, stat '/tmp/x.pdf'",
    code: 'UPLOAD_FAILED',
    details: { reason: "Error: ENOENT: no such file or directory, stat '/tmp/x.pdf'" },
  },
  {
    name: 'script error',
    message: 'page.evaluate: ReferenceError: foo is not defined\n    at eval (eval at evaluate)',
    code: 'SCRIPT_ERROR',
    details: { message: 'ReferenceError: foo is not defined' },
  },
  {
    name: 'element not visible',
    message:
      "locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('#hidden')\n  - element is not visible",
    errorName: 'TimeoutError',
    ctx: { selector: '#hidden' },
    code: 'ELEMENT_NOT_ACTIONABLE',
    details: { selector: '#hidden', detail: 'locator.click: Timeout 5000ms exceeded.' },
  },
  {
    name: 'element intercepts pointer events',
    message: '<div class="overlay"></div> intercepts pointer events\n  - retrying click action',
    ctx: { selector: '#btn' },
    code: 'ELEMENT_NOT_ACTIONABLE',
    details: { selector: '#btn', detail: '<div class="overlay"></div> intercepts pointer events' },
  },
  {
    name: 'wait for selector timeout',
    message:
      "page.waitForSelector: Timeout 1000ms exceeded.\nCall log:\n  - waiting for locator('#never') to be visible",
    errorName: 'TimeoutError',
    ctx: { what: "selector '#never' to be visible" },
    code: 'WAIT_TIMEOUT',
    details: { what: "selector '#never' to be visible", timeout_ms: 1000 },
  },
  {
    name: 'wait for load state timeout',
    message: 'page.waitForLoadState: Timeout 2000ms exceeded.',
    errorName: 'TimeoutError',
    code: 'WAIT_TIMEOUT',
    details: { what: 'page.waitForLoadState:', timeout_ms: 2000 },
  },
];

describe('classifyDriverError fixture table', () => {
  it.each(FIXTURES.map((f): [string, (typeof FIXTURES)[number]] => [f.name, f]))(
    '%s',
    (_name, fixture) => {
      const err = new Error(fixture.message);
      if (fixture.errorName !== undefined) err.name = fixture.errorName;
      const classified = classifyDriverError(err, fixture.ctx ?? {});
      expect(classified).toBeInstanceOf(AppError);
      expect(classified?.code).toBe(fixture.code);
      expect(classified?.details).toEqual(fixture.details);
      expect(classified?.cause).toBe(err);
      expect(classified?.publicMessage.length ?? 0).toBeGreaterThan(0);
    },
  );

  it('appends the driver detail to the actionability message', () => {
    const err = new Error(
      'locator.click: Timeout 5000ms exceeded.\nCall log: element is not visible',
    );
    const classified = classifyDriverError(err, { selector: '#x' });
    expect(classified?.publicMessage).toMatch(/^Element '#x' did not become actionable/);
    expect(classified?.publicMessage).toMatch(/ \(locator\.click: Timeout 5000ms exceeded\.\)$/);
  });

  it('routes a bare TimeoutError by context and returns null for unknown prose', () => {
    const timeout = new Error('something else entirely');
    timeout.name = 'TimeoutError';
    expect(classifyDriverError(timeout, { selector: '#a' })?.code).toBe('ELEMENT_NOT_ACTIONABLE');
    expect(classifyDriverError(timeout, { what: 'x', timeoutMs: 7 })?.details).toEqual({
      what: 'x',
      timeout_ms: 7,
    });
    expect(classifyDriverError(new Error('totally unrelated'))).toBeNull();
    expect(classifyDriverError('not an error')).toBeNull();
  });

  it('passes an AppError through untouched', () => {
    const app = new AppError('URL_BLOCKED', { url: 'https://x', pattern: 'x' });
    expect(classifyDriverError(app)).toBe(app);
  });

  it('exposes the actionability predicate and the closed-target predicate', () => {
    const t = new Error('x');
    t.name = 'TimeoutError';
    expect(isActionabilityError(t)).toBe(true);
    expect(isActionabilityError(new Error('element is not attached'))).toBe(true);
    expect(isActionabilityError(new Error('nope'))).toBe(false);
    expect(isTargetClosedError(new Error('page.url: Target closed'))).toBe(true);
    expect(isTargetClosedError(new Error('fine'))).toBe(false);
  });
});
