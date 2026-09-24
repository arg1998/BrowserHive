/** @module lib/api/keys — query key factory per REST resource; params are stable (sorted keys) so equal searches share a cache entry (spec 04 §5) */

/** Any parsed search/query object. */
export type KeyParams = Readonly<Record<string, unknown>>;

/** Return a copy with sorted keys and `undefined` values removed (recursively) so keys hash stably. */
export function stableParams(params: KeyParams | undefined): KeyParams {
  if (params === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined) continue;
    out[key] =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? stableParams(value as KeyParams)
        : value;
  }
  return out;
}

/** Query keys. Prefix arrays (`all`, `lists`) are what the WS bridge and invalidations target. */
export const keys = {
  auth: {
    all: ['auth'] as const,
    me: () => ['auth', 'me'] as const,
    sessions: () => ['auth', 'sessions'] as const,
    tokens: () => ['auth', 'tokens'] as const,
    /** Mutation key of `createToken` (its result holds a plaintext token and is purged on close). */
    tokenCreate: () => ['auth', 'token-create'] as const,
  },
  health: () => ['health'] as const,
  sessions: {
    all: ['sessions'] as const,
    lists: () => ['sessions', 'list'] as const,
    list: (params?: KeyParams) => ['sessions', 'list', stableParams(params)] as const,
    detail: (id: string) => ['sessions', 'detail', id] as const,
    timelines: (id: string) => ['sessions', 'timeline', id] as const,
    timeline: (id: string, facet: string, params?: KeyParams) =>
      ['sessions', 'timeline', id, facet, stableParams(params)] as const,
    artifacts: (id: string) => ['sessions', 'artifacts', id] as const,
    trace: (id: string) => ['sessions', 'trace', id] as const,
    attention: (id: string) => ['sessions', 'attention', id] as const,
    confirms: (id: string) => ['sessions', 'confirms', id] as const,
    screenshots: (id: string, params?: KeyParams) =>
      ['sessions', 'screenshots', id, stableParams(params)] as const,
    /** Page visits read as context for a page of screenshots (host and title at capture time). */
    pageContext: (id: string, params?: KeyParams) =>
      ['sessions', 'page-context', id, stableParams(params)] as const,
  },
  attention: {
    all: ['attention'] as const,
    lists: () => ['attention', 'list'] as const,
    list: (params?: KeyParams) => ['attention', 'list', stableParams(params)] as const,
    pending: () => ['attention', 'pending'] as const,
    openCount: () => ['attention', 'open-count'] as const,
  },
  vault: {
    all: ['vault'] as const,
    state: () => ['vault', 'state'] as const,
    status: () => ['vault', 'status'] as const,
    groups: () => ['vault', 'groups'] as const,
    items: (params?: KeyParams) => ['vault', 'items', stableParams(params)] as const,
    bindings: (params?: KeyParams) => ['vault', 'bindings', stableParams(params)] as const,
    confirms: () => ['vault', 'confirms'] as const,
    confirmCount: () => ['vault', 'confirm-count'] as const,
    logs: () => ['vault', 'log'] as const,
    log: (params?: KeyParams) => ['vault', 'log', stableParams(params)] as const,
  },
  blocklist: {
    all: ['blocklist'] as const,
    state: (params?: KeyParams) => ['blocklist', 'state', stableParams(params)] as const,
    stats: () => ['blocklist', 'state'] as const,
    attemptLists: () => ['blocklist', 'attempts'] as const,
    attempts: (params?: KeyParams) => ['blocklist', 'attempts', stableParams(params)] as const,
  },
  websites: {
    all: ['websites'] as const,
    histories: () => ['websites', 'history'] as const,
    history: (params?: KeyParams) => ['websites', 'history', stableParams(params)] as const,
    recent: () => ['websites', 'recent'] as const,
    domainLists: () => ['websites', 'domains'] as const,
    domains: (params?: KeyParams) => ['websites', 'domains', stableParams(params)] as const,
  },
  overview: {
    all: ['overview'] as const,
    activity: (params?: KeyParams) => ['overview', 'activity', stableParams(params)] as const,
    failures: (params?: KeyParams) => ['overview', 'failures', stableParams(params)] as const,
    harnesses: (params?: KeyParams) => ['overview', 'harnesses', stableParams(params)] as const,
  },
  toolCalls: {
    all: ['tool-calls'] as const,
    list: (params?: KeyParams) => ['tool-calls', 'list', stableParams(params)] as const,
  },
  system: {
    all: ['system'] as const,
    status: () => ['system', 'status'] as const,
    config: () => ['system', 'config'] as const,
    realtime: () => ['system', 'realtime'] as const,
    mcpConnections: () => ['system', 'mcp-connections'] as const,
    events: (params?: KeyParams) => ['system', 'events', stableParams(params)] as const,
  },
  logs: {
    all: ['logs'] as const,
    list: (params?: KeyParams) => ['logs', 'list', stableParams(params)] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    lists: () => ['notifications', 'list'] as const,
    list: (params?: KeyParams) => ['notifications', 'list', stableParams(params)] as const,
    unreadCount: () => ['notifications', 'unread-count'] as const,
  },
  preferences: () => ['preferences'] as const,
  search: (q: string) => ['search', q] as const,
} as const;
