/** @module contracts/test/errors.registry — registry completeness, stable message texts, projections */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  codesInCategory,
  ERROR_CODES,
  ERROR_REGISTRY,
  ErrorCategory,
  ErrorCodeSchema,
  errorDocsUrl,
  errorSpec,
  httpAuditCode,
  httpAuditStatus,
  isErrorCode,
  isHttpAuditCode,
  McpErrorContent,
  ProblemDetails,
  Retryable,
  renderMessage,
} from '../src/errors/index.ts';

/** The core tool, session, vault and boot codes whose message texts are pinned below. */
const CORE_CODES = [
  'SESSION_NOT_FOUND',
  'SESSION_ALREADY_EXISTS',
  'SESSION_DEAD',
  'SESSION_LIMIT_REACHED',
  'UNKNOWN_CHANNEL',
  'UNSAFE_LAUNCH_ARG',
  'INVALID_PERSISTENCE_CONFIG',
  'TAB_NOT_FOUND',
  'PATH_NOT_ALLOWED',
  'EVALUATE_DISABLED',
  'VAULT_NOT_CONFIGURED',
  'VAULT_LOCKED',
  'VAULT_ENTRY_NOT_FOUND',
  'VAULT_NOT_AUTHORIZED',
  'ORIGIN_MISMATCH',
  'EVALUATE_REQUIRED_OFF',
  'DASHBOARD_DENIED',
  'ADMIN_REQUIRES_HTTP',
  'ATTENTION_REQUIRES_HTTP',
  'INVALID_SLUG',
  'INSECURE_BIND_REFUSED',
  'SESSION_ACCESS_DENIED',
  'AUTH_STATE_NOT_FOUND',
  'ELEMENT_NOT_ACTIONABLE',
  'URL_BLOCKED',
] as const;

/** The remaining codes named by spec 10 §1.1. */
const SPEC_CODES = [
  'SESSION_NOT_AVAILABLE',
  'ELEMENT_NOT_FOUND',
  'NAVIGATION_TIMEOUT',
  'NAVIGATION_FAILED',
  'WAIT_TIMEOUT',
  'SCRIPT_ERROR',
  'DOWNLOAD_FAILED',
  'UPLOAD_FAILED',
  'PAGE_CLOSED',
  'BROWSER_CRASHED',
  'VAULT_UNLOCK_FAILED',
  'VAULT_SYNC_UNSUPPORTED',
  'VAULT_BACKEND_ERROR',
  'ATTENTION_NOT_OPEN',
  'CONFIRM_NOT_OPEN',
  'INPUT_NOT_PERMITTED',
  'SCREENCAST_FAILED',
  'TOOL_NOT_AVAILABLE',
  'INVALID_ARGUMENTS',
  'INTERNAL_ERROR',
  'PORT_IN_USE',
  'BIND_FAILED',
  'CONFIG_INVALID',
  'CONFIG_UNKNOWN_KEY',
  'BLOCKLIST_LOAD_FAILED',
  'DATA_DIR_UNWRITABLE',
  'DB_OPEN_FAILED',
  'DB_NEWER_THAN_BINARY',
  'MIGRATION_FAILED',
  'DB_CORRUPT',
  'BROWSER_NOT_INSTALLED',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'PASSWORD_CHANGE_REQUIRED',
  'BAD_CURRENT_PASSWORD',
  'WEAK_PASSWORD',
  'ORIGIN_NOT_ALLOWED',
  'HOST_NOT_ALLOWED',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'NOT_ACCEPTABLE',
  'TRACE_UNAVAILABLE',
  'SCREENSHOT_UNAVAILABLE',
  'SESSION_NOT_LIVE',
  'SESSION_LIVE',
  'WS_PROTOCOL_ERROR',
  'WS_OVERLOADED',
  'VAULT_FILL_AUTH_FAILED',
  'VAULT_FILL_BLOCKED',
  'VAULT_LIST_DENIED',
  'ATTENTION_REJECTED',
  'ATTENTION_TIMEOUT',
  'ATTENTION_CANCELLED',
  'EXECUTABLE_PATH_OVERRIDE',
  'TRACE_START_FAILED',
  'TRACE_FINALIZE_FAILED',
  'STEALTH_INIT_FAILED',
  'BLOCKLIST_ROUTE_FAILED',
  'BYO_PROXY_UNSEEDED',
  'VIEWPORT_OVERRIDE_UNASSERTED',
  'IDENTITY_SEED_SAVE_FAILED',
  'REAP_DEAD_FAILED',
  'CDP_SESSION_LEAKED',
  'SCREENSHOT_ARCHIVE_FAILED',
  'UNHANDLED',
  'RETENTION_FAILED',
  'STALE_BROWSER_PROCESSES',
  'DATA_DIR_LOCKED',
  'SANDBOX_UNAVAILABLE',
] as const;

describe('ERROR_REGISTRY completeness', () => {
  it('contains every core code and every spec 10 §1.1 code', () => {
    for (const code of [...CORE_CODES, ...SPEC_CODES]) {
      expect(isErrorCode(code)).toBe(true);
    }
    // The dashboard shares the one HTTP listener, so listener failures are PORT_IN_USE/BIND_FAILED.
    expect(isErrorCode('ADMIN_LISTENER_FAILED')).toBe(false);
    expect(ERROR_CODES.length).toBe(CORE_CODES.length + SPEC_CODES.length);
  });

  it('keys equal codes and every entry has title, message, hint, cause and resolution prose', () => {
    for (const code of ERROR_CODES) {
      const spec = ERROR_REGISTRY[code];
      expect(spec.code).toBe(code);
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.message.length).toBeGreaterThan(0);
      expect(spec.hint?.length ?? 0).toBeGreaterThan(0);
      expect(spec.cause?.length ?? 0).toBeGreaterThan(0);
      expect(spec.resolution?.length ?? 0).toBeGreaterThan(0);
      expect(spec.docs).toBe(true);
      expect(Retryable.safeParse(spec.retryable).success).toBe(true);
      expect(ErrorCategory.safeParse(spec.category).success).toBe(true);
      expect(spec.details).toBeInstanceOf(z.ZodObject);
      expect(Number.isInteger(spec.httpStatus)).toBe(true);
    }
  });

  it('boot codes carry an exit code; other categories do not', () => {
    for (const code of ERROR_CODES) {
      const spec = ERROR_REGISTRY[code];
      if (spec.category === 'boot') expect([1, 3, 64]).toContain(spec.exitCode ?? -1);
      else expect(spec.exitCode).toBeUndefined();
    }
    expect(ERROR_REGISTRY.INSECURE_BIND_REFUSED.exitCode).toBe(3);
    expect(ERROR_REGISTRY.ADMIN_REQUIRES_HTTP.exitCode).toBe(3);
    expect(ERROR_REGISTRY.PORT_IN_USE.exitCode).toBe(3);
    expect(ERROR_REGISTRY.SANDBOX_UNAVAILABLE.exitCode).toBe(3);
    expect(ERROR_REGISTRY.SANDBOX_UNAVAILABLE.retryable).toBe('never');
    expect(ERROR_REGISTRY.CONFIG_INVALID.exitCode).toBe(64);
    expect(ERROR_REGISTRY.CONFIG_UNKNOWN_KEY.exitCode).toBe(64);
  });

  it('message placeholders name details keys (or documented derived labels)', () => {
    const derivedLabels = new Set(['kind_label', 'summary']);
    for (const code of ERROR_CODES) {
      const spec = ERROR_REGISTRY[code];
      const keys = new Set(Object.keys(spec.details.shape));
      for (const match of spec.message.matchAll(/\{([a-z_]+)\}/g)) {
        const slot = match[1] ?? '';
        expect(keys.has(slot) || derivedLabels.has(slot)).toBe(true);
      }
    }
  });

  it('INTERNAL_ERROR details are { ref: string }', () => {
    expect(ERROR_REGISTRY.INTERNAL_ERROR.details.safeParse({ ref: 'r1' }).success).toBe(true);
    expect(ERROR_REGISTRY.INTERNAL_ERROR.details.safeParse({}).success).toBe(false);
    expect(errorSpec('INTERNAL_ERROR').httpStatus).toBe(500);
  });

  it('categories partition the codes; audit and warning codes are never thrown', () => {
    const total = ErrorCategory.options.reduce((n: number, c) => n + codesInCategory(c).length, 0);
    expect(total).toBe(ERROR_CODES.length);
    expect(codesInCategory('warning')).toHaveLength(11);
    expect(codesInCategory('audit')).toContain('ORIGIN_MISMATCH');
    expect(codesInCategory('boot')).toContain('PORT_IN_USE');
  });
});

describe('error message texts are stable', () => {
  const cases: ReadonlyArray<
    readonly [(typeof CORE_CODES)[number], Record<string, unknown>, string]
  > = [
    [
      'SESSION_NOT_FOUND',
      { session_id: 'shop-a1b2c3d4' },
      "No browser session with id 'shop-a1b2c3d4'",
    ],
    [
      'SESSION_ACCESS_DENIED',
      { session_id: 'shop-a1b2c3d4' },
      "No browser session with id 'shop-a1b2c3d4'",
    ],
    [
      'SESSION_DEAD',
      { session_id: 's-1' },
      "Session 's-1' is dead — its underlying browser process crashed.",
    ],
    [
      'SESSION_LIMIT_REACHED',
      { limit: 4, live: 4 },
      'Concurrent session limit reached (max=4). Close a session and retry.',
    ],
    [
      'TAB_NOT_FOUND',
      { session_id: 's-1', tab_id: '<active>' },
      "Tab '<active>' not found in session 's-1'.",
    ],
    [
      'EVALUATE_DISABLED',
      { session_id: 's-1' },
      "The 'evaluate' tool is disabled for session 's-1'.",
    ],
    [
      'ATTENTION_REQUIRES_HTTP',
      { tool: 'request_attention' },
      "'request_attention' requires the http transport; human-in-the-loop attention is not available under stdio.",
    ],
    [
      'VAULT_NOT_CONFIGURED',
      {},
      'No vault backend is configured. Start the server with --vault <backend>.',
    ],
    [
      'UNKNOWN_CHANNEL',
      { channel: 'firefox' },
      "Unknown browser channel 'firefox'. Expected one of: chromium, chrome, edge.",
    ],
    [
      'UNSAFE_LAUNCH_ARG',
      { arg: '--no-sandbox' },
      "Launch arg '--no-sandbox' is on the deny-list and would break session isolation.",
    ],
  ];
  for (const [code, details, expected] of cases) {
    it(`${code}`, () => {
      expect(renderMessage(ERROR_REGISTRY[code].message, details)).toBe(expected);
    });
  }

  it('URL_BLOCKED keeps the do-not-retry text', () => {
    const text = renderMessage(ERROR_REGISTRY.URL_BLOCKED.message, {
      url: 'https://x',
      pattern: 'x/*',
    });
    expect(text).toBe(
      "The URL 'https://x' is blocked by the administrator (matched the blocklist pattern 'x/*'). This is an operator policy, not a transient failure — do not retry this URL, and do not try to reach it by another route. Report it to the user if the task cannot continue.",
    );
  });

  it('AUTH_STATE_NOT_FOUND renders the kind label from extra vars', () => {
    const text = renderMessage(
      ERROR_REGISTRY.AUTH_STATE_NOT_FOUND.message,
      { name: 'gh', kind: 'profile' },
      { kind_label: 'full-profile' },
    );
    expect(text).toBe(
      "No saved full-profile snapshot named 'gh'. Use list_saved_auths to see what is available.",
    );
  });

  it('leaves unknown slots visible', () => {
    expect(renderMessage('x {nope}', {})).toBe('x {nope}');
  });
});

describe('HTTP audit codes', () => {
  it('builds and recognises HTTP_<n> for 400-599 only', () => {
    expect(httpAuditCode(404)).toBe('HTTP_404');
    expect(isHttpAuditCode('HTTP_503')).toBe(true);
    expect(isHttpAuditCode('HTTP_200')).toBe(false);
    expect(isHttpAuditCode('SESSION_NOT_FOUND')).toBe(false);
    expect(httpAuditStatus('HTTP_418')).toBe(418);
    expect(httpAuditStatus('nope')).toBeUndefined();
    expect(() => httpAuditCode(200)).toThrow(RangeError);
  });
});

describe('projections', () => {
  it('ProblemDetails and McpErrorContent accept registry codes only', () => {
    const problem = ProblemDetails.safeParse({
      type: errorDocsUrl('ATTENTION_NOT_OPEN'),
      title: 'Attention request is not open',
      status: 409,
      code: 'ATTENTION_NOT_OPEN',
      retryable: 'never',
      details: { request_id: 'a-1', status: 'resolved' },
    });
    expect(problem.success).toBe(true);
    expect(errorDocsUrl('X')).toBe('https://browserhive.ai/docs/errors#X');
    expect(
      McpErrorContent.safeParse({ code: 'NOPE', message: 'm', retryable: 'never' }).success,
    ).toBe(false);
    expect(ErrorCodeSchema.options).toEqual([...ERROR_CODES]);
  });
});
