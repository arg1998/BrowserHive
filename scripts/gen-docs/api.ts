/** @module scripts/gen-docs/api — renders docs/reference/api.md from HTTP_ENDPOINTS (+ OpenAPI summaries when generated) */
import type { AuthMethod } from '@browserhive/contracts/enums';
import { Scope } from '@browserhive/contracts/enums';
import { API_PREFIX, HTTP_ENDPOINTS, type HttpEndpoint } from '@browserhive/contracts/http';
import { document, GENERATED_HEADER, inlineCode, isRecord, table } from './markdown.ts';

/** Summaries keyed by `operationId`, read from `packages/contracts/generated/openapi.json` when present. */
export type OperationSummaries = ReadonlyMap<string, string>;

/** Section title per first path segment; unknown segments get their own section named after the segment. */
const RESOURCE_TITLES: Readonly<Record<string, string>> = {
  health: 'Health',
  auth: 'Authentication',
  sessions: 'Sessions',
  'tool-calls': 'Activity and metrics',
  activity: 'Activity and metrics',
  metrics: 'Activity and metrics',
  pages: 'Websites (pages)',
  attention: 'Attention',
  vault: 'Vault',
  blocklist: 'Blocklist',
  system: 'System and configuration',
  logs: 'Logs',
  'openapi.json': 'API description',
  docs: 'API description',
  notifications: 'Notifications and preferences',
  me: 'Notifications and preferences',
  search: 'Search',
  'client-errors': 'Client errors',
  ws: 'Realtime',
};

const AUTH_LABELS: Readonly<Record<AuthMethod, string>> = {
  'password-session': 'cookie',
  bearer: 'bearer',
  grant: 'grant',
};

/**
 * Extract `operationId → summary` from a parsed OpenAPI document.
 *
 * @returns The summaries (empty when the document has no usable `paths`).
 */
export function summariesFromOpenApi(doc: unknown): OperationSummaries {
  const out = new Map<string, string>();
  if (!isRecord(doc) || !isRecord(doc['paths'])) return out;
  for (const item of Object.values(doc['paths'])) {
    if (!isRecord(item)) continue;
    for (const operation of Object.values(item)) {
      if (!isRecord(operation) || typeof operation['operationId'] !== 'string') continue;
      const summary = operation['summary'] ?? operation['description'];
      if (typeof summary === 'string') out.set(operation['operationId'], summary);
    }
  }
  return out;
}

function sectionOf(endpoint: HttpEndpoint): string {
  const segment = endpoint.path.split('/')[1] ?? '';
  return RESOURCE_TITLES[segment] ?? segment;
}

function authText(endpoint: HttpEndpoint): string {
  if (endpoint.auth.length === 0) return 'public';
  return endpoint.auth.map((a) => AUTH_LABELS[a]).join(', ');
}

/**
 * Render `docs/reference/api.md`.
 *
 * @returns The Markdown document.
 */
export function renderApi(summaries: OperationSummaries): string {
  const sections = new Map<string, HttpEndpoint[]>();
  for (const endpoint of HTTP_ENDPOINTS) {
    const title = sectionOf(endpoint);
    const list = sections.get(title) ?? [];
    list.push(endpoint);
    sections.set(title, list);
  }
  const withSummaries = summaries.size > 0;
  const headers = ['Method', 'Path', 'operationId', 'Scope', 'Auth'];
  if (withSummaries) headers.push('Summary');
  const blocks = [...sections].map(([title, endpoints]) => {
    const rows = endpoints.map((e) => {
      const row = [
        e.method.toUpperCase(),
        inlineCode(`${API_PREFIX}${e.path}`),
        inlineCode(e.operationId),
        e.scope === null ? '—' : inlineCode(e.scope),
        authText(e),
      ];
      if (withSummaries) row.push(summaries.get(e.operationId) ?? '—');
      return row;
    });
    return [`## ${title}`, '', table(headers, rows)].join('\n');
  });
  return document([
    GENERATED_HEADER,
    '# REST API reference',
    `The admin REST API served under \`${API_PREFIX}\` on the same port as MCP and the dashboard when \`--admin\` is on (${HTTP_ENDPOINTS.length} operations), generated from \`HTTP_ENDPOINTS\` in \`@browserhive/contracts/http\`. Request and response schemas are in the OpenAPI 3.1 document the server serves at \`${API_PREFIX}/openapi.json\`, with an interactive reference UI at \`${API_PREFIX}/docs\`.`,
    withSummaries
      ? 'Summaries come from `packages/contracts/generated/openapi.json`.'
      : 'Summaries are omitted because `packages/contracts/generated/openapi.json` was not present when this file was generated; the running server always serves the full document.',
    '## Conventions',
    [
      '- **Authentication:** `cookie` is the dashboard session cookie `browserhive_session` (from `POST /api/v1/auth/login`); `bearer` is `Authorization: Bearer <token>` (operator API tokens or agent tokens); `grant` is a short-lived `?grant=<token>` accepted only on trace and screenshot downloads; `public` needs nothing.',
      '- **Authorization:** the scope column is checked for the caller. Operators hold every scope; agent tokens hold `mcp:tools` only.',
      '- **Wire format:** JSON bodies are snake_case; timestamps are epoch milliseconds.',
      '- **Errors:** `application/problem+json` with a registry `code`; see the [error reference](errors.md).',
      '- **Collections:** `{ data, page: { next_cursor, prev_cursor?, limit, total? }, facets?, applied, meta }`, cursor-paginated; unknown query keys are rejected with 400.',
      '- **Concurrency:** vault bindings and group policies take `If-Match: <version>`; a stale version returns 409 `CONFLICT`. Bulk operations accept `Idempotency-Key`.',
      '- **Realtime:** `GET /api/v1/ws` upgrades to the WebSocket protocol described in the [WebSocket reference](websocket.md).',
    ].join('\n'),
    '## Scopes',
    Scope.options.map(inlineCode).join(' · '),
    ...blocks,
  ]);
}
