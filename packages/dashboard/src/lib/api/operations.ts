/** @module lib/api/operations — typed map operationId → request/response contracts schemas (the dashboard's replacement for Hono's `AppType`) */
import {
  ActivityQuery,
  ActivityResponse,
  ApiTokenList,
  ArchiveSessionResponse,
  AttentionPage,
  AttentionQuery,
  AuthSessionIdPrefixParams,
  AuthSessionList,
  BlockedAttemptsPage,
  BlockedAttemptsQuery,
  BlocklistOverview,
  BlocklistOverviewQuery,
  BulkAttentionRequest,
  BulkRequestsResponse,
  BulkSessionsRequest,
  BulkSessionsResponse,
  BulkVaultConfirmRequest,
  ChangePasswordRequest,
  ChangePasswordResponse,
  ClientErrorReport,
  CreateGrantRequest,
  CreateGrantResponse,
  CreateTokenRequest,
  CreateTokenResponse,
  CredentialIdParams,
  DeleteSessionResponse,
  DeleteVaultBindingResponse,
  GroupIdParams,
  HandleParams,
  HarnessMetricsQuery,
  HarnessMetricsResponse,
  HealthResponse,
  ImportVaultQuery,
  ImportVaultResponse,
  LockVaultResponse,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  LogsPage,
  LogsQuery,
  McpConnectionsQuery,
  McpConnectionsResponse,
  MeResponse,
  NotificationAckResponse,
  NotificationIdParams,
  NotificationsPage,
  NotificationsQuery,
  NotificationsUpdatedResponse,
  OkResponse,
  PageDomainsQuery,
  PageDomainsResponse,
  PagesPage,
  PagesQuery,
  PreferencesResponse,
  PutGroupPolicyRequest,
  PutGroupPolicyResponse,
  PutPreferencesRequest,
  PutPreferencesResponse,
  PutVaultBindingRequest,
  PutVaultBindingResponse,
  RecentPagesQuery,
  RecentPagesResponse,
  ReloadBlocklistResponse,
  RequestIdParams,
  ResolveAttentionRequest,
  ResolveBindingsRequest,
  ResolveBindingsResponse,
  ResolveRequestResponse,
  ResolveVaultConfirmRequest,
  RevealDataDirResponse,
  RevokeAllSessionsResponse,
  ScreenshotsPage,
  SearchQuery,
  SearchResponse,
  SessionAttentionPage,
  SessionAttentionQuery,
  SessionDetail,
  SessionEventParams,
  SessionIdParams,
  SessionInputRequest,
  SessionInputResponse,
  SessionPagesPage,
  SessionPagesQuery,
  SessionScreenshotsQuery,
  SessionsPage,
  SessionsQuery,
  SessionToolCallsPage,
  SessionToolCallsQuery,
  SessionTraceInfo,
  SetLogLevelRequest,
  SetLogLevelResponse,
  SetViewportRequest,
  SetViewportResponse,
  SyncVaultResponse,
  SystemConfigResponse,
  SystemEventsPage,
  SystemEventsQuery,
  SystemInfo,
  SystemRealtimeResponse,
  TerminateSessionResponse,
  TimelinePage,
  TimelineQuery,
  ToolCallDetail,
  ToolCallsPage,
  ToolCallsQuery,
  ToolMetricsQuery,
  ToolMetricsResponse,
  UnlockVaultRequest,
  UnlockVaultResponse,
  VaultBindingsPage,
  VaultBindingsQuery,
  VaultConfirmPage,
  VaultConfirmQuery,
  VaultExportDocument,
  VaultGroupsResponse,
  VaultItemsPage,
  VaultItemsQuery,
  VaultLogPage,
  VaultLogQuery,
  VaultOverview,
  VaultStatus,
} from '@browserhive/contracts/http';
import type { z } from 'zod';

/** One operation's contracts. Missing `response` = 204 (no body). */
export interface OperationDef {
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly response?: z.ZodType;
  /** Bulk endpoints: the call must carry an `Idempotency-Key`. */
  readonly idempotent?: true;
  /** Versioned updates: the call carries `If-Match` (omitted on create). */
  readonly ifMatch?: true;
}

/** Every JSON operation of `HTTP_ENDPOINTS` (spec 03 §4). Binary/stream routes are addressed with `api.url()`. */
export const OPERATIONS = {
  // §4.1 health and auth
  getHealth: { response: HealthResponse },
  login: { body: LoginRequest, response: LoginResponse },
  logout: { response: LogoutResponse },
  getMe: { response: MeResponse },
  changePassword: { body: ChangePasswordRequest, response: ChangePasswordResponse },
  listAuthSessions: { response: AuthSessionList },
  revokeAuthSession: { params: AuthSessionIdPrefixParams, response: OkResponse },
  revokeAllAuthSessions: { response: RevokeAllSessionsResponse },
  listTokens: { response: ApiTokenList },
  createToken: { body: CreateTokenRequest, response: CreateTokenResponse },
  revokeToken: { params: CredentialIdParams, response: OkResponse },
  createGrant: { body: CreateGrantRequest, response: CreateGrantResponse },
  // §4.2 sessions
  listSessions: { query: SessionsQuery, response: SessionsPage },
  bulkSessions: { body: BulkSessionsRequest, response: BulkSessionsResponse, idempotent: true },
  getSession: { params: SessionIdParams, response: SessionDetail },
  listSessionToolCalls: {
    params: SessionIdParams,
    query: SessionToolCallsQuery,
    response: SessionToolCallsPage,
  },
  getSessionToolCall: { params: SessionEventParams, response: ToolCallDetail },
  listSessionPages: {
    params: SessionIdParams,
    query: SessionPagesQuery,
    response: SessionPagesPage,
  },
  listSessionAttention: {
    params: SessionIdParams,
    query: SessionAttentionQuery,
    response: SessionAttentionPage,
  },
  listSessionVaultAccess: { params: SessionIdParams, query: VaultLogQuery, response: VaultLogPage },
  listSessionBlocked: {
    params: SessionIdParams,
    query: BlockedAttemptsQuery,
    response: BlockedAttemptsPage,
  },
  listSessionScreenshots: {
    params: SessionIdParams,
    query: SessionScreenshotsQuery,
    response: ScreenshotsPage,
  },
  getSessionTimeline: { params: SessionIdParams, query: TimelineQuery, response: TimelinePage },
  getSessionTrace: { params: SessionIdParams, response: SessionTraceInfo },
  revealSessionDataDir: { params: SessionIdParams, response: RevealDataDirResponse },
  terminateSession: { params: SessionIdParams, response: TerminateSessionResponse },
  archiveSession: { params: SessionIdParams, response: ArchiveSessionResponse },
  unarchiveSession: { params: SessionIdParams, response: ArchiveSessionResponse },
  deleteSession: { params: SessionIdParams, response: DeleteSessionResponse },
  setSessionViewport: {
    params: SessionIdParams,
    body: SetViewportRequest,
    response: SetViewportResponse,
  },
  sendSessionInput: {
    params: SessionIdParams,
    body: SessionInputRequest,
    response: SessionInputResponse,
  },
  // §4.3 cross-session activity and metrics
  listToolCalls: { query: ToolCallsQuery, response: ToolCallsPage },
  getActivity: { query: ActivityQuery, response: ActivityResponse },
  getToolMetrics: { query: ToolMetricsQuery, response: ToolMetricsResponse },
  getHarnessMetrics: { query: HarnessMetricsQuery, response: HarnessMetricsResponse },
  listPages: { query: PagesQuery, response: PagesPage },
  listRecentPages: { query: RecentPagesQuery, response: RecentPagesResponse },
  listPageDomains: { query: PageDomainsQuery, response: PageDomainsResponse },
  // §4.4 operator requests
  listAttention: { query: AttentionQuery, response: AttentionPage },
  resolveAttention: {
    params: RequestIdParams,
    body: ResolveAttentionRequest,
    response: ResolveRequestResponse,
  },
  bulkAttention: { body: BulkAttentionRequest, response: BulkRequestsResponse, idempotent: true },
  listVaultConfirm: { query: VaultConfirmQuery, response: VaultConfirmPage },
  resolveVaultConfirm: {
    params: RequestIdParams,
    body: ResolveVaultConfirmRequest,
    response: ResolveRequestResponse,
  },
  bulkVaultConfirm: {
    body: BulkVaultConfirmRequest,
    response: BulkRequestsResponse,
    idempotent: true,
  },
  // §4.5 vault
  getVault: { response: VaultOverview },
  getVaultStatus: { response: VaultStatus },
  unlockVault: { body: UnlockVaultRequest, response: UnlockVaultResponse },
  lockVault: { response: LockVaultResponse },
  syncVault: { response: SyncVaultResponse },
  listVaultGroups: { response: VaultGroupsResponse },
  putVaultGroupPolicy: {
    params: GroupIdParams,
    body: PutGroupPolicyRequest,
    response: PutGroupPolicyResponse,
    ifMatch: true,
  },
  listVaultItems: { query: VaultItemsQuery, response: VaultItemsPage },
  listVaultBindings: { query: VaultBindingsQuery, response: VaultBindingsPage },
  putVaultBinding: {
    params: HandleParams,
    body: PutVaultBindingRequest,
    response: PutVaultBindingResponse,
    ifMatch: true,
  },
  deleteVaultBinding: { params: HandleParams, response: DeleteVaultBindingResponse },
  resolveVaultBindings: { body: ResolveBindingsRequest, response: ResolveBindingsResponse },
  listVaultLog: { query: VaultLogQuery, response: VaultLogPage },
  exportVault: { response: VaultExportDocument },
  importVault: {
    query: ImportVaultQuery,
    body: VaultExportDocument,
    response: ImportVaultResponse,
  },
  // §4.6 blocklist
  getBlocklist: { query: BlocklistOverviewQuery, response: BlocklistOverview },
  reloadBlocklist: { response: ReloadBlocklistResponse },
  listBlockedAttempts: { query: BlockedAttemptsQuery, response: BlockedAttemptsPage },
  // §4.7 system, config, logs
  getSystem: { response: SystemInfo },
  getSystemConfig: { response: SystemConfigResponse },
  getSystemRealtime: { response: SystemRealtimeResponse },
  listMcpConnections: { query: McpConnectionsQuery, response: McpConnectionsResponse },
  setLogLevel: { body: SetLogLevelRequest, response: SetLogLevelResponse },
  listSystemEvents: { query: SystemEventsQuery, response: SystemEventsPage },
  listLogs: { query: LogsQuery, response: LogsPage },
  // §4.8 notifications, preferences, search
  listNotifications: { query: NotificationsQuery, response: NotificationsPage },
  markNotificationRead: { params: NotificationIdParams, response: NotificationAckResponse },
  markAllNotificationsRead: { response: NotificationsUpdatedResponse },
  dismissNotification: { params: NotificationIdParams, response: NotificationAckResponse },
  dismissAllNotifications: { response: NotificationsUpdatedResponse },
  getPreferences: { response: PreferencesResponse },
  putPreferences: { body: PutPreferencesRequest, response: PutPreferencesResponse },
  search: { query: SearchQuery, response: SearchResponse },
  // §4.9 client errors (204)
  reportClientError: { body: ClientErrorReport },
} as const satisfies Record<string, OperationDef>;

/** Every JSON operation id. */
export type OperationId = keyof typeof OPERATIONS;

type Def<K extends OperationId> = (typeof OPERATIONS)[K];
type Input<S> = S extends z.ZodType ? z.input<S> : never;
type Output<S> = S extends z.ZodType ? z.output<S> : never;
/** `{}` extends T when every key of T is optional. */
type AllOptional<T> = Record<never, never> extends T ? true : false;
type OptionalIfEmpty<Name extends string, T> =
  AllOptional<T> extends true ? { readonly [N in Name]?: T } : { readonly [N in Name]: T };

/** Typed call input for one operation (params/query/body as the contracts `z.input`). */
export type OpInput<K extends OperationId> = (Def<K> extends { params: infer P }
  ? { readonly params: Input<P> }
  : unknown) &
  (Def<K> extends { query: infer Q } ? OptionalIfEmpty<'query', Input<Q>> : unknown) &
  (Def<K> extends { body: infer B } ? OptionalIfEmpty<'body', Input<B>> : unknown) &
  (Def<K> extends { idempotent: true } ? { readonly idempotencyKey: string } : unknown) &
  (Def<K> extends { ifMatch: true } ? { readonly ifMatch?: number } : unknown) & {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  };

/** Typed result of one operation (`undefined` for 204 routes). */
export type OpOutput<K extends OperationId> =
  Def<K> extends { response: infer R } ? Output<R> : undefined;

/** Path params as the transport sees them. */
export type PathParams = Readonly<Record<string, string | number>>;
/** Query params as the transport sees them (arrays serialise as comma lists). */
export type QueryParams = Readonly<
  Record<string, string | number | boolean | readonly (string | number)[] | null | undefined>
>;
