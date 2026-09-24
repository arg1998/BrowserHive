/** @module test/helpers/http-route-cases — one success request and one validation-failure request per `/api/v1` operation (spec 09 §3.2). */

import { ARCHIVED_ID, CLOSED_ID, EVENT_OK } from './http-fixtures.ts';
import type { HttpKit } from './http-kit.ts';
import { PASSWORD } from './http-kit.ts';

/** Context handed to dynamic paths and setup hooks. */
export interface CaseContext {
  readonly kit: HttpKit;
  readonly cookie: string;
  /** Values produced by `setup`. */
  readonly state: Record<string, string>;
}

/** One request of a case. */
export interface CaseRequest {
  readonly method?: string;
  readonly path: string | ((ctx: CaseContext) => string);
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Send without the session cookie. */
  readonly anonymous?: boolean;
}

/** The cases of one operation. */
export interface RouteCase {
  readonly operationId: string;
  readonly success: CaseRequest & { readonly status: number };
  /** `null` when the route declares no request schema (nothing can fail validation). */
  readonly invalid: CaseRequest | null;
  readonly setup?: (ctx: CaseContext) => Promise<void>;
}

/** A valid `Idempotency-Key`. */
export const IDEMPOTENCY_KEY = '5b3e6f2a-6d8f-4e8a-9d62-2b0d8a1d2c11';

const api = (path: string) => `/api/v1${path}`;
const s = (path: string) => api(`/sessions/${CLOSED_ID}${path}`);

async function liveSession(ctx: CaseContext): Promise<void> {
  const session = await ctx.kit.sessions.create({ slug: 'live' }, { subject: 'admin' });
  ctx.state['live'] = session.id;
}

async function takeover(ctx: CaseContext): Promise<void> {
  await liveSession(ctx);
  void ctx.kit.attention.request(
    ctx.state['live'] ?? '',
    { reason: 'captcha', mode: 'takeover' },
    { principal: 'agent-1' },
  );
  await new Promise((r) => setTimeout(r, 0));
}

async function openRequest(ctx: CaseContext, kind: 'attention' | 'vault_confirm'): Promise<void> {
  const handle = await ctx.kit.broker.open({
    kind,
    sessionId: CLOSED_ID,
    owner: 'agent-1',
    reason: 'check',
    ...(kind === 'attention' ? { mode: 'notify' as const } : { entryName: 'work.github' }),
  });
  ctx.state['request'] = handle.id;
}

const live = (path: string) => (ctx: CaseContext) =>
  api(`/sessions/${ctx.state['live'] ?? ''}${path}`);
const bad = api('/sessions/NOT_AN_ID');

/** Every case, in manifest order. */
export const ROUTE_CASES: readonly RouteCase[] = [
  { operationId: 'getHealth', success: { path: api('/health'), status: 200 }, invalid: null },
  {
    operationId: 'login',
    success: {
      method: 'POST',
      path: api('/auth/login'),
      body: { password: PASSWORD },
      anonymous: true,
      status: 200,
    },
    invalid: { method: 'POST', path: api('/auth/login'), body: {}, anonymous: true },
  },
  {
    operationId: 'logout',
    success: { method: 'POST', path: api('/auth/logout'), status: 200 },
    invalid: null,
  },
  { operationId: 'getMe', success: { path: api('/auth/me'), status: 200 }, invalid: null },
  {
    operationId: 'changePassword',
    success: {
      method: 'POST',
      path: api('/auth/change-password'),
      body: { current_password: PASSWORD, new_password: 'a much longer passphrase' },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: api('/auth/change-password'),
      body: { current_password: PASSWORD, new_password: 'short' },
    },
  },
  {
    operationId: 'listAuthSessions',
    success: { path: api('/auth/sessions'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'revokeAuthSession',
    setup: async (ctx) => {
      const sessions = await ctx.kit.authService.listSessions(await principalOf(ctx));
      ctx.state['prefix'] = sessions[0]?.idPrefix ?? '';
    },
    success: {
      method: 'DELETE',
      path: (ctx) => api(`/auth/sessions/${ctx.state['prefix'] ?? ''}`),
      status: 200,
    },
    invalid: { method: 'DELETE', path: api('/auth/sessions/ab') },
  },
  {
    operationId: 'revokeAllAuthSessions',
    success: { method: 'POST', path: api('/auth/sessions/revoke-all'), status: 200 },
    invalid: null,
  },
  { operationId: 'listTokens', success: { path: api('/auth/tokens'), status: 200 }, invalid: null },
  {
    operationId: 'createToken',
    success: {
      method: 'POST',
      path: api('/auth/tokens'),
      body: { owner_kind: 'agent', display: 'bot' },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: api('/auth/tokens'),
      body: { owner_kind: 'robot', display: 'bot' },
    },
  },
  {
    operationId: 'revokeToken',
    setup: async (ctx) => {
      const token = await ctx.kit.authService.createToken(await principalOf(ctx), {
        ownerKind: 'agent',
        display: 'bot',
      });
      ctx.state['credential'] = token.credentialId;
    },
    success: {
      method: 'DELETE',
      path: (ctx) => api(`/auth/tokens/${ctx.state['credential'] ?? ''}`),
      status: 200,
    },
    invalid: { method: 'DELETE', path: api(`/auth/tokens/${'x'.repeat(200)}`) },
  },
  {
    operationId: 'createGrant',
    success: {
      method: 'POST',
      path: api('/auth/grants'),
      body: { route: 'trace', resource_id: CLOSED_ID },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: api('/auth/grants'),
      body: { route: 'video', resource_id: CLOSED_ID },
    },
  },
  {
    operationId: 'listSessions',
    success: { path: api('/sessions'), status: 200 },
    invalid: { path: api('/sessions?sort=bogus') },
  },
  {
    operationId: 'bulkSessions',
    success: {
      method: 'POST',
      path: api('/sessions/bulk'),
      body: { action: 'archive', session_ids: [CLOSED_ID] },
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: api('/sessions/bulk'),
      body: { action: 'archive', session_ids: [CLOSED_ID] },
    },
  },
  { operationId: 'getSession', success: { path: s(''), status: 200 }, invalid: { path: bad } },
  {
    operationId: 'listSessionToolCalls',
    success: { path: s('/tool-calls?expand=detail'), status: 200 },
    invalid: { path: s('/tool-calls?ok=maybe') },
  },
  {
    operationId: 'getSessionToolCall',
    success: { path: s(`/tool-calls/${EVENT_OK}`), status: 200 },
    invalid: { path: s('/tool-calls/bad') },
  },
  {
    operationId: 'listSessionPages',
    success: { path: s('/pages'), status: 200 },
    invalid: { path: s('/pages?category=bogus') },
  },
  {
    operationId: 'listSessionAttention',
    success: { path: s('/attention'), status: 200 },
    invalid: { path: s('/attention?status=bogus') },
  },
  {
    operationId: 'listSessionVaultAccess',
    success: { path: s('/vault-access'), status: 200 },
    invalid: { path: s('/vault-access?result=bogus') },
  },
  {
    operationId: 'listSessionBlocked',
    success: { path: s('/blocked'), status: 200 },
    invalid: { path: s('/blocked?source=bogus') },
  },
  {
    operationId: 'listSessionScreenshots',
    success: { path: s('/screenshots'), status: 200 },
    invalid: { path: s('/screenshots?kind=bogus') },
  },
  {
    operationId: 'getSessionTimeline',
    success: { path: s('/timeline'), status: 200 },
    invalid: { path: s('/timeline?kinds=bogus') },
  },
  {
    operationId: 'getScreenshotImage',
    success: { path: s(`/screenshots/${EVENT_OK}`), status: 200 },
    invalid: { path: s('/screenshots/bad') },
  },
  {
    operationId: 'getTraceZip',
    success: { path: s('/trace.zip'), status: 200 },
    invalid: { path: s('/trace.zip?extra=1') },
  },
  {
    operationId: 'headTraceZip',
    success: { method: 'HEAD', path: s('/trace.zip'), status: 200 },
    invalid: { method: 'HEAD', path: s('/trace.zip?extra=1') },
  },
  {
    operationId: 'getSessionTrace',
    success: { path: s('/trace'), status: 200 },
    invalid: { path: `${bad}/trace` },
  },
  {
    operationId: 'revealSessionDataDir',
    success: { method: 'POST', path: s('/data-dir/reveal'), status: 200 },
    invalid: { method: 'POST', path: `${bad}/data-dir/reveal` },
  },
  {
    operationId: 'terminateSession',
    setup: liveSession,
    success: { method: 'POST', path: live('/terminate'), status: 200 },
    invalid: { method: 'POST', path: `${bad}/terminate` },
  },
  {
    operationId: 'archiveSession',
    success: { method: 'POST', path: s('/archive'), status: 200 },
    invalid: { method: 'POST', path: `${bad}/archive` },
  },
  {
    operationId: 'unarchiveSession',
    success: { method: 'POST', path: api(`/sessions/${ARCHIVED_ID}/unarchive`), status: 200 },
    invalid: { method: 'POST', path: `${bad}/unarchive` },
  },
  {
    operationId: 'deleteSession',
    success: { method: 'DELETE', path: s(''), status: 200 },
    invalid: { method: 'DELETE', path: bad },
  },
  {
    operationId: 'setSessionViewport',
    setup: liveSession,
    success: {
      method: 'POST',
      path: live('/viewport'),
      body: { width: 800, height: 600 },
      status: 200,
    },
    invalid: { method: 'POST', path: live('/viewport'), body: { width: 10, height: 600 } },
  },
  {
    operationId: 'sendSessionInput',
    setup: takeover,
    success: {
      method: 'POST',
      path: live('/input'),
      body: { inputs: [{ type: 'mouse', action: 'mouseMoved', x: 1, y: 2 }] },
      status: 200,
    },
    invalid: { method: 'POST', path: live('/input'), body: { inputs: [] } },
  },
  {
    operationId: 'exportSession',
    success: { path: s('/export'), headers: { accept: 'application/x-ndjson' }, status: 200 },
    invalid: { path: s('/export?kinds=bogus') },
  },
  {
    operationId: 'listToolCalls',
    success: { path: api('/tool-calls'), status: 200 },
    invalid: { path: api('/tool-calls?session_id=bad') },
  },
  {
    operationId: 'getActivity',
    success: { path: api('/activity'), status: 200 },
    invalid: { path: api('/activity?bucket_ms=5') },
  },
  {
    operationId: 'getToolMetrics',
    success: { path: api('/metrics/tools'), status: 200 },
    invalid: { path: api('/metrics/tools?group_by=nope') },
  },
  {
    operationId: 'getHarnessMetrics',
    success: { path: api('/metrics/harnesses'), status: 200 },
    invalid: { path: api('/metrics/harnesses?since=soon') },
  },
  {
    operationId: 'listPages',
    success: { path: api('/pages'), status: 200 },
    invalid: { path: api('/pages?sort=bogus') },
  },
  {
    operationId: 'listRecentPages',
    success: { path: api('/pages/recent'), status: 200 },
    invalid: { path: api('/pages/recent?limit=999') },
  },
  {
    operationId: 'listPageDomains',
    success: { path: api('/pages/domains'), status: 200 },
    invalid: { path: api('/pages/domains?limit=0') },
  },
  {
    operationId: 'listAttention',
    success: { path: api('/attention'), status: 200 },
    invalid: { path: api('/attention?mode=bogus') },
  },
  {
    operationId: 'resolveAttention',
    setup: (ctx) => openRequest(ctx, 'attention'),
    success: {
      method: 'POST',
      path: (ctx) => api(`/attention/${ctx.state['request'] ?? ''}/resolve`),
      body: { decision: 'resolve' },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: (ctx) => api(`/attention/${ctx.state['request'] ?? ''}/resolve`),
      body: { decision: 'maybe' },
    },
  },
  {
    operationId: 'bulkAttention',
    setup: (ctx) => openRequest(ctx, 'attention'),
    success: {
      method: 'POST',
      path: api('/attention/bulk'),
      body: { action: 'reject', request_ids: ['a-000000000999'] },
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: api('/attention/bulk'),
      body: { action: 'reject', request_ids: [] },
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
    },
  },
  {
    operationId: 'listVaultConfirm',
    success: { path: api('/vault/confirm'), status: 200 },
    invalid: { path: api('/vault/confirm?status=bogus') },
  },
  {
    operationId: 'resolveVaultConfirm',
    setup: (ctx) => openRequest(ctx, 'vault_confirm'),
    success: {
      method: 'POST',
      path: (ctx) => api(`/vault/confirm/${ctx.state['request'] ?? ''}/resolve`),
      body: { decision: 'approve' },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: (ctx) => api(`/vault/confirm/${ctx.state['request'] ?? ''}/resolve`),
      body: { decision: 'maybe' },
    },
  },
  {
    operationId: 'bulkVaultConfirm',
    setup: (ctx) => openRequest(ctx, 'vault_confirm'),
    success: {
      method: 'POST',
      path: api('/vault/confirm/bulk'),
      body: { action: 'deny', request_ids: ['a-000000000999'] },
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: api('/vault/confirm/bulk'),
      body: { action: 'maybe', request_ids: ['a-000000000999'] },
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
    },
  },
  { operationId: 'getVault', success: { path: api('/vault'), status: 200 }, invalid: null },
  {
    operationId: 'getVaultStatus',
    success: { path: api('/vault/status'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'unlockVault',
    success: {
      method: 'POST',
      path: api('/vault/unlock'),
      body: { token: 'fake-session-token' },
      status: 200,
    },
    invalid: { method: 'POST', path: api('/vault/unlock'), body: {} },
  },
  {
    operationId: 'lockVault',
    success: { method: 'POST', path: api('/vault/lock'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'syncVault',
    success: { method: 'POST', path: api('/vault/sync'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'listVaultGroups',
    success: { path: api('/vault/groups'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'putVaultGroupPolicy',
    success: {
      method: 'PUT',
      path: api('/vault/groups/__ungrouped__/policy'),
      body: { access_mode: 'manual' },
      status: 200,
    },
    invalid: {
      method: 'PUT',
      path: api('/vault/groups/__ungrouped__/policy'),
      body: { access_mode: 'always' },
    },
  },
  {
    operationId: 'listVaultItems',
    success: { path: api('/vault/items'), status: 200 },
    invalid: { path: api('/vault/items?sort=bogus') },
  },
  {
    operationId: 'listVaultBindings',
    success: { path: api('/vault/bindings'), status: 200 },
    invalid: { path: api('/vault/bindings?sort=bogus') },
  },
  {
    operationId: 'putVaultBinding',
    success: {
      method: 'PUT',
      path: api('/vault/bindings/new.binding'),
      body: { item_name: 'New', allowed_origins: ['https://new.example'] },
      status: 200,
    },
    invalid: {
      method: 'PUT',
      path: api('/vault/bindings/NOT%20VALID'),
      body: { item_name: 'New' },
    },
  },
  {
    operationId: 'deleteVaultBinding',
    success: { method: 'DELETE', path: api('/vault/bindings/work.github'), status: 200 },
    invalid: { method: 'DELETE', path: api('/vault/bindings/NOT%20VALID') },
  },
  {
    operationId: 'resolveVaultBindings',
    success: {
      method: 'POST',
      path: api('/vault/bindings/resolve'),
      body: { url: 'https://github.com/login' },
      status: 200,
    },
    invalid: { method: 'POST', path: api('/vault/bindings/resolve'), body: { url: 'not a url' } },
  },
  {
    operationId: 'listVaultLog',
    success: { path: api('/vault/log'), status: 200 },
    invalid: { path: api('/vault/log?evaluate=maybe') },
  },
  {
    operationId: 'exportVault',
    success: { path: api('/vault/export'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'importVault',
    success: {
      method: 'POST',
      path: api('/vault/import?mode=merge'),
      body: { version: 3, bindings: [], policies: [] },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: api('/vault/import?mode=overwrite'),
      body: { version: 3, bindings: [], policies: [] },
    },
  },
  {
    operationId: 'getBlocklist',
    success: { path: api('/blocklist'), status: 200 },
    invalid: { path: api('/blocklist?since=-1') },
  },
  {
    operationId: 'reloadBlocklist',
    success: { method: 'POST', path: api('/blocklist/reload'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'listBlockedAttempts',
    success: { path: api('/blocklist/attempts'), status: 200 },
    invalid: { path: api('/blocklist/attempts?source=bogus') },
  },
  { operationId: 'getSystem', success: { path: api('/system'), status: 200 }, invalid: null },
  {
    operationId: 'getSystemConfig',
    success: { path: api('/system/config'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'getSystemRealtime',
    success: { path: api('/system/realtime'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'listMcpConnections',
    success: { path: api('/system/mcp/connections'), status: 200 },
    invalid: { path: api('/system/mcp/connections?limit=0') },
  },
  {
    operationId: 'setLogLevel',
    success: {
      method: 'PATCH',
      path: api('/system/log-level'),
      body: { spec: 'info,sessions=debug' },
      status: 200,
    },
    invalid: { method: 'PATCH', path: api('/system/log-level'), body: { spec: 'loud' } },
  },
  {
    operationId: 'listSystemEvents',
    success: { path: api('/system/events'), status: 200 },
    invalid: { path: api('/system/events?resolved=maybe') },
  },
  {
    operationId: 'listLogs',
    success: { path: api('/logs'), status: 200 },
    invalid: { path: api('/logs?limit=5000') },
  },
  {
    operationId: 'exportLogs',
    success: { path: api('/logs/export'), status: 200 },
    invalid: { path: api('/logs/export?level=loud') },
  },
  {
    operationId: 'getOpenApi',
    success: { path: api('/openapi.json'), anonymous: true, status: 200 },
    invalid: null,
  },
  {
    operationId: 'getDocs',
    success: { path: api('/docs'), anonymous: true, status: 200 },
    invalid: null,
  },
  {
    operationId: 'listNotifications',
    success: { path: api('/notifications'), status: 200 },
    invalid: { path: api('/notifications?read=maybe') },
  },
  {
    operationId: 'markNotificationRead',
    success: { method: 'POST', path: api('/notifications/n-000000000001/read'), status: 200 },
    invalid: { method: 'POST', path: api('/notifications/bad/read') },
  },
  {
    operationId: 'markAllNotificationsRead',
    success: { method: 'POST', path: api('/notifications/read-all'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'dismissNotification',
    success: { method: 'DELETE', path: api('/notifications/n-000000000001'), status: 200 },
    invalid: { method: 'DELETE', path: api('/notifications/bad') },
  },
  {
    operationId: 'dismissAllNotifications',
    success: { method: 'POST', path: api('/notifications/dismiss-all'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'getPreferences',
    success: { path: api('/me/preferences'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'putPreferences',
    success: {
      method: 'PUT',
      path: api('/me/preferences'),
      body: { preferences: { sidebar: 'collapsed' } },
      status: 200,
    },
    invalid: {
      method: 'PUT',
      path: api('/me/preferences'),
      body: { preferences: { bogus: true } },
    },
  },
  {
    operationId: 'search',
    success: { path: api('/search?q=shop'), status: 200 },
    invalid: { path: api('/search?q=s') },
  },
  {
    operationId: 'reportClientError',
    success: {
      method: 'POST',
      path: api('/client-errors'),
      body: { message: 'boom', route: '/sessions', user_agent: 'test', build: 'dev' },
      status: 204,
    },
    invalid: { method: 'POST', path: api('/client-errors'), body: { message: '' } },
  },
];

async function principalOf(ctx: CaseContext) {
  const sessions = [...ctx.kit.authKit.repos.tables.authSessions.values()];
  const current = sessions[sessions.length - 1];
  return {
    subject: 'admin',
    kind: 'operator' as const,
    display: 'admin',
    auth: {
      method: 'password-session' as const,
      ...(current !== undefined && { sessionId: current.authSessionId }),
    },
    scopes: [],
    tenantId: null,
    mustChangePassword: false,
  };
}
