/** @module infra/browsers/classify-error — ordered regex table mapping Playwright error prose onto registry codes; each row is pinned by a fixture. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';

/** What the caller knows about the failed operation; fills detail slots the prose lacks. */
export interface ClassifyContext {
  readonly selector?: string;
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly tabId?: string;
  readonly sessionId?: string;
  /** Human label of the awaited condition (`selector '#x' to be visible`, `load state`). */
  readonly what?: string;
  readonly channel?: string;
}

interface Row {
  readonly test: RegExp;
  readonly build: (m: RegExpExecArray, message: string, ctx: ClassifyContext) => AppError | null;
}

/** First line of a Playwright message, trimmed and capped — the "detail" appended to actionability errors. */
export function firstLine(message: string, max = 160): string {
  return message.split('\n')[0]?.trim().slice(0, max) ?? '';
}

function rendered<C extends keyof typeof ERROR_REGISTRY>(
  code: C,
  details: Readonly<Record<string, unknown>>,
): string {
  return renderMessage(ERROR_REGISTRY[code].message, details);
}

function timeoutFrom(m: RegExpExecArray, ctx: ClassifyContext): number {
  const fromProse = m.groups?.['ms'];
  return ctx.timeoutMs ?? (fromProse === undefined ? 0 : Number(fromProse));
}

const CLOSED_RE =
  /Target page, context or browser has been closed|Target closed|Execution context was destroyed|Session closed\. Most likely the page has been closed|Browser has been closed|Navigation failed because page was closed|Page closed|Browser closed|Connection closed|has been closed/;

/**
 * The ordered table. Earlier rows win, so the specific (strict-mode violation, download, upload,
 * script) rows precede the generic timeout rows, and the "closed" row precedes everything that
 * would otherwise read a closed-target message as a timeout.
 */
const ROWS: readonly Row[] = [
  {
    test: /Executable doesn't exist at|Chromium distribution '(?<channel>[\w-]+)' is not found|Failed to launch: .*ENOENT|Looks like Playwright Test or Playwright was just installed or updated/,
    build: (m, _message, ctx) => {
      const channel = ctx.channel ?? m.groups?.['channel'] ?? 'chromium';
      const details = { channel, install_command: 'browserhive init' };
      return new AppError('BROWSER_NOT_INSTALLED', details, {
        publicMessage: rendered('BROWSER_NOT_INSTALLED', details),
      });
    },
  },
  {
    test: CLOSED_RE,
    build: (_m, _message, ctx) => {
      if (ctx.tabId !== undefined) {
        const details = { tab_id: ctx.tabId };
        return new AppError('PAGE_CLOSED', details, {
          publicMessage: rendered('PAGE_CLOSED', details),
        });
      }
      const details = { session_id: ctx.sessionId ?? 'unknown' };
      return new AppError('BROWSER_CRASHED', details, {
        publicMessage: rendered('BROWSER_CRASHED', details),
      });
    },
  },
  {
    test: /strict mode violation: .*resolved to (?<count>\d+) elements/s,
    build: (m, _message, ctx) => {
      const details = { selector: ctx.selector ?? '', count: Number(m.groups?.['count'] ?? 0) };
      return new AppError('ELEMENT_NOT_FOUND', details, {
        publicMessage: rendered('ELEMENT_NOT_FOUND', details),
      });
    },
  },
  {
    test: /(?:page|frame)\.goto: Timeout (?<ms>\d+)ms exceeded/,
    build: (m, _message, ctx) => {
      const details = { url: ctx.url ?? '', timeout_ms: timeoutFrom(m, ctx) };
      return new AppError('NAVIGATION_TIMEOUT', details, {
        publicMessage: rendered('NAVIGATION_TIMEOUT', details),
      });
    },
  },
  {
    test: /(?<net>net::ERR_[A-Z0-9_]+)/,
    build: (m, _message, ctx) => {
      const details = { url: ctx.url ?? '', net_error: m.groups?.['net'] ?? 'net::ERR_FAILED' };
      return new AppError('NAVIGATION_FAILED', details, {
        publicMessage: rendered('NAVIGATION_FAILED', details),
      });
    },
  },
  {
    test: /download\.(?:path|saveAs|failure|createReadStream): (?<reason>.+)|Download (?<reason2>(?:deleted|canceled|failed).*)/,
    build: (m) => {
      const details = {
        reason: firstLine(m.groups?.['reason'] ?? m.groups?.['reason2'] ?? 'unknown'),
      };
      return new AppError('DOWNLOAD_FAILED', details, {
        publicMessage: rendered('DOWNLOAD_FAILED', details),
      });
    },
  },
  {
    test: /setInputFiles: (?<reason>.+)/,
    build: (m) => {
      const details = { reason: firstLine(m.groups?.['reason'] ?? 'unknown') };
      return new AppError('UPLOAD_FAILED', details, {
        publicMessage: rendered('UPLOAD_FAILED', details),
      });
    },
  },
  {
    test: /^(?:page|frame|locator|elementHandle|jsHandle|worker)\.(?:evaluate|evaluateHandle|evaluateAll|\$eval|\$\$eval): (?!Timeout)(?<message>.+)/s,
    build: (m) => {
      const details = { message: firstLine(m.groups?.['message'] ?? 'unknown') };
      return new AppError('SCRIPT_ERROR', details, {
        publicMessage: rendered('SCRIPT_ERROR', details),
      });
    },
  },
  {
    test: /element is (?:not visible|not stable|not enabled|not attached|outside of the viewport)|intercepts pointer events|(?:click|dblclick|hover|fill|type|press|check|uncheck|selectOption|tap|dragTo|dragAndDrop|focus|scrollIntoViewIfNeeded|boundingBox|inputValue|innerText|textContent|selectText|setChecked|clear|pressSequentially): Timeout (?<ms>\d+)ms exceeded/,
    build: (_m, message, ctx) => actionability(message, ctx),
  },
  {
    test: /(?:waitForSelector|waitForFunction|waitForLoadState|waitForURL|waitForEvent|waitForResponse|waitForRequest|waitForNavigation|waitFor|waitForTimeout|expect)\w*: Timeout (?<ms>\d+)ms exceeded/,
    build: (m, message, ctx) => {
      const stripped = firstLine(message.replace(/Timeout \d+ms exceeded\.?\s*/, ''));
      const details = {
        what: ctx.what ?? (stripped.length > 0 ? stripped : 'condition'),
        timeout_ms: timeoutFrom(m, ctx),
      };
      return new AppError('WAIT_TIMEOUT', details, {
        publicMessage: rendered('WAIT_TIMEOUT', details),
      });
    },
  },
];

function actionability(message: string, ctx: ClassifyContext): AppError {
  const detail = firstLine(message);
  const details = { selector: ctx.selector ?? '', ...(detail.length > 0 && { detail }) };
  // Core appends " ({detail})" when a driver detail is available (registry note).
  const base = rendered('ELEMENT_NOT_ACTIONABLE', details);
  return new AppError('ELEMENT_NOT_ACTIONABLE', details, {
    publicMessage: detail.length > 0 ? `${base} (${detail})` : base,
  });
}

/**
 * Whether a thrown error is a Playwright **actionability** failure (element hidden / unstable /
 * disabled / detached / covered / off-screen). Playwright's actionability waits reject with a
 * `TimeoutError`; a few failures surface the same call-log phrasing without timing out.
 */
export function isActionabilityError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'TimeoutError' ||
    /element is (?:not visible|not stable|not enabled|not attached|outside of the viewport)|intercepts pointer events/i.test(
      err.message,
    )
  );
}

/** True for the "target closed" family (page, context or browser gone). */
export function isTargetClosedError(err: unknown): boolean {
  return err instanceof Error && CLOSED_RE.test(err.message);
}

/**
 * Map a Playwright error onto a registry `AppError`, or `null` when the prose matches no row.
 * An `AppError` passes through unchanged. Every returned error carries the original as `cause`.
 */
export function classifyDriverError(err: unknown, ctx: ClassifyContext = {}): AppError | null {
  if (isAppError(err)) return err;
  if (!(err instanceof Error)) return null;
  const message = err.message;
  for (const row of ROWS) {
    const m = row.test.exec(message);
    if (m === null) continue;
    const built = row.build(m, message, ctx);
    if (built === null) continue;
    return withCause(built, err);
  }
  // A bare TimeoutError with no recognisable prose: the context decides which timeout it was.
  if (err.name === 'TimeoutError') {
    if (ctx.selector !== undefined) return withCause(actionability(message, ctx), err);
    const details = { what: ctx.what ?? 'condition', timeout_ms: ctx.timeoutMs ?? 0 };
    return withCause(
      new AppError('WAIT_TIMEOUT', details, { publicMessage: rendered('WAIT_TIMEOUT', details) }),
      err,
    );
  }
  return null;
}

function withCause(error: AppError, cause: unknown): AppError {
  return new AppError(error.code, error.details, {
    publicMessage: error.publicMessage,
    message: error.message,
    cause,
  });
}
