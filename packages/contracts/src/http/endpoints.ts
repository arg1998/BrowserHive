/** @module contracts/http/endpoints — the one manifest of every `/api/v1` route (operationId, method, path, scope, auth) */
import type { AuthMethod, Scope } from '../enums/index.ts';

/** HTTP methods used by the API. */
export type HttpMethod = 'get' | 'head' | 'post' | 'put' | 'patch' | 'delete';

/** One route in the manifest. `scope: null` = no scope check (public or authenticated-only). `auth: []` = public. */
export interface HttpEndpoint {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Path relative to `/api/v1`, OpenAPI style params (`{session_id}`). */
  readonly path: string;
  readonly scope: Scope | null;
  readonly auth: readonly AuthMethod[];
}

/** API prefix (spec 03 §1.3). */
export const API_PREFIX = '/api/v1';

const S: readonly AuthMethod[] = ['password-session', 'bearer'];
const SG: readonly AuthMethod[] = ['password-session', 'bearer', 'grant'];
const P: readonly AuthMethod[] = [];

function ep(
  operationId: string,
  method: HttpMethod,
  path: string,
  scope: Scope | null,
  auth: readonly AuthMethod[] = S,
): HttpEndpoint {
  return { operationId, method, path, scope, auth };
}

/** Every REST route of `/api/v1` (spec 03 §4). Shared by the router, OpenAPI, the dashboard and route tests. */
export const HTTP_ENDPOINTS: readonly HttpEndpoint[] = [
  // §4.1 health and auth
  ep('getHealth', 'get', '/health', null, P),
  ep('login', 'post', '/auth/login', null, P),
  ep('logout', 'post', '/auth/logout', null),
  ep('getMe', 'get', '/auth/me', null),
  ep('changePassword', 'post', '/auth/change-password', null),
  ep('listAuthSessions', 'get', '/auth/sessions', null),
  ep('revokeAuthSession', 'delete', '/auth/sessions/{id_prefix}', null),
  ep('revokeAllAuthSessions', 'post', '/auth/sessions/revoke-all', null),
  ep('listTokens', 'get', '/auth/tokens', null),
  ep('createToken', 'post', '/auth/tokens', null),
  ep('revokeToken', 'delete', '/auth/tokens/{credential_id}', null),
  ep('createGrant', 'post', '/auth/grants', null),
  // §4.2 sessions
  ep('listSessions', 'get', '/sessions', 'sessions:read'),
  ep('bulkSessions', 'post', '/sessions/bulk', 'sessions:write'),
  ep('getSession', 'get', '/sessions/{session_id}', 'sessions:read'),
  ep('listSessionToolCalls', 'get', '/sessions/{session_id}/tool-calls', 'sessions:read'),
  ep('getSessionToolCall', 'get', '/sessions/{session_id}/tool-calls/{event_id}', 'sessions:read'),
  ep('listSessionPages', 'get', '/sessions/{session_id}/pages', 'sessions:read'),
  ep('listSessionAttention', 'get', '/sessions/{session_id}/attention', 'attention:read'),
  ep('listSessionVaultAccess', 'get', '/sessions/{session_id}/vault-access', 'vault:read'),
  ep('listSessionBlocked', 'get', '/sessions/{session_id}/blocked', 'blocklist:read'),
  ep('listSessionScreenshots', 'get', '/sessions/{session_id}/screenshots', 'sessions:read'),
  ep('getSessionTimeline', 'get', '/sessions/{session_id}/timeline', 'sessions:read'),
  ep(
    'getScreenshotImage',
    'get',
    '/sessions/{session_id}/screenshots/{event_id}',
    'sessions:read',
    SG,
  ),
  ep('getTraceZip', 'get', '/sessions/{session_id}/trace.zip', 'sessions:read', SG),
  ep('headTraceZip', 'head', '/sessions/{session_id}/trace.zip', 'sessions:read', SG),
  ep('getSessionTrace', 'get', '/sessions/{session_id}/trace', 'sessions:read'),
  ep('revealSessionDataDir', 'post', '/sessions/{session_id}/data-dir/reveal', 'sessions:read'),
  ep('terminateSession', 'post', '/sessions/{session_id}/terminate', 'sessions:write'),
  ep('archiveSession', 'post', '/sessions/{session_id}/archive', 'sessions:write'),
  ep('unarchiveSession', 'post', '/sessions/{session_id}/unarchive', 'sessions:write'),
  ep('deleteSession', 'delete', '/sessions/{session_id}', 'sessions:write'),
  ep('setSessionViewport', 'post', '/sessions/{session_id}/viewport', 'sessions:write'),
  ep('sendSessionInput', 'post', '/sessions/{session_id}/input', 'sessions:takeover'),
  ep('exportSession', 'get', '/sessions/{session_id}/export', 'sessions:read'),
  // §4.3 cross-session activity and metrics
  ep('listToolCalls', 'get', '/tool-calls', 'sessions:read'),
  ep('getActivity', 'get', '/activity', 'sessions:read'),
  ep('getToolMetrics', 'get', '/metrics/tools', 'sessions:read'),
  ep('getHarnessMetrics', 'get', '/metrics/harnesses', 'sessions:read'),
  ep('listPages', 'get', '/pages', 'sessions:read'),
  ep('listRecentPages', 'get', '/pages/recent', 'sessions:read'),
  ep('listPageDomains', 'get', '/pages/domains', 'sessions:read'),
  // §4.4 operator requests
  ep('listAttention', 'get', '/attention', 'attention:read'),
  ep('resolveAttention', 'post', '/attention/{request_id}/resolve', 'attention:resolve'),
  ep('bulkAttention', 'post', '/attention/bulk', 'attention:resolve'),
  ep('listVaultConfirm', 'get', '/vault/confirm', 'vault:read'),
  ep('resolveVaultConfirm', 'post', '/vault/confirm/{request_id}/resolve', 'vault:confirm'),
  ep('bulkVaultConfirm', 'post', '/vault/confirm/bulk', 'vault:confirm'),
  // §4.5 vault
  ep('getVault', 'get', '/vault', 'vault:read'),
  ep('getVaultStatus', 'get', '/vault/status', 'vault:read'),
  ep('unlockVault', 'post', '/vault/unlock', 'vault:write'),
  ep('lockVault', 'post', '/vault/lock', 'vault:write'),
  ep('syncVault', 'post', '/vault/sync', 'vault:write'),
  ep('listVaultGroups', 'get', '/vault/groups', 'vault:read'),
  ep('putVaultGroupPolicy', 'put', '/vault/groups/{group_id}/policy', 'vault:write'),
  ep('listVaultItems', 'get', '/vault/items', 'vault:read'),
  ep('listVaultBindings', 'get', '/vault/bindings', 'vault:read'),
  ep('putVaultBinding', 'put', '/vault/bindings/{handle}', 'vault:write'),
  ep('deleteVaultBinding', 'delete', '/vault/bindings/{handle}', 'vault:write'),
  ep('resolveVaultBindings', 'post', '/vault/bindings/resolve', 'vault:read'),
  ep('listVaultLog', 'get', '/vault/log', 'vault:read'),
  ep('exportVault', 'get', '/vault/export', 'vault:read'),
  ep('importVault', 'post', '/vault/import', 'vault:write'),
  // §4.6 blocklist
  ep('getBlocklist', 'get', '/blocklist', 'blocklist:read'),
  ep('reloadBlocklist', 'post', '/blocklist/reload', 'blocklist:write'),
  ep('listBlockedAttempts', 'get', '/blocklist/attempts', 'blocklist:read'),
  // §4.7 system, config, logs
  ep('getSystem', 'get', '/system', 'system:read'),
  ep('getSystemConfig', 'get', '/system/config', 'system:read'),
  ep('getSystemRealtime', 'get', '/system/realtime', 'system:read'),
  ep('listMcpConnections', 'get', '/system/mcp/connections', 'system:read'),
  ep('setLogLevel', 'patch', '/system/log-level', 'system:write'),
  ep('listSystemEvents', 'get', '/system/events', 'system:read'),
  ep('listLogs', 'get', '/logs', 'logs:read'),
  ep('exportLogs', 'get', '/logs/export', 'logs:read'),
  ep('getOpenApi', 'get', '/openapi.json', null, P),
  ep('getDocs', 'get', '/docs', null, P),
  // §4.8 notifications, preferences, search
  ep('listNotifications', 'get', '/notifications', 'notifications:read'),
  ep(
    'markNotificationRead',
    'post',
    '/notifications/{notification_id}/read',
    'notifications:write',
  ),
  ep('markAllNotificationsRead', 'post', '/notifications/read-all', 'notifications:write'),
  ep('dismissNotification', 'delete', '/notifications/{notification_id}', 'notifications:write'),
  ep('dismissAllNotifications', 'post', '/notifications/dismiss-all', 'notifications:write'),
  ep('getPreferences', 'get', '/me/preferences', null),
  ep('putPreferences', 'put', '/me/preferences', 'preferences:write'),
  ep('search', 'get', '/search', 'sessions:read'),
  // §4.9 client errors
  ep('reportClientError', 'post', '/client-errors', null),
  // §6 realtime upgrade (auth runs at upgrade; scopes are checked per WS command)
  ep('wsUpgrade', 'get', '/ws', null),
];

/** Look up one endpoint by `operationId`; `undefined` when unknown. */
export function findEndpoint(operationId: string): HttpEndpoint | undefined {
  return HTTP_ENDPOINTS.find((e) => e.operationId === operationId);
}

/** Routes reachable while `must_change_password` is set (spec 03 §2, `passwordChangeGate`). */
export const PASSWORD_CHANGE_ALLOWED_OPERATIONS: readonly string[] = [
  'getMe',
  'changePassword',
  'logout',
];
