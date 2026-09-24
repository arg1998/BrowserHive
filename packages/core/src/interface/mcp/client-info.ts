/** @module interface/mcp/client-info — the optional `X-BH-*` client headers (spec 02 §1.4, docs/guide/mcp-clients.md) and the per-call `SessionClientInfo`. Self-reported: dashboard only, never for access control. */

import { clientInfoOrNull, type SessionClientInfo } from '../../domain/session/client-info.ts';

/** `X-BH-Agent-Harness` → `mcp_connections.harness`. */
export const HARNESS_HEADER = 'x-bh-agent-harness';
/** `X-BH-Agent-Model` → `mcp_connections.model`. */
export const MODEL_HEADER = 'x-bh-agent-model';
/** `X-BH-Workspace` → `mcp_connections.agent_name`. */
export const WORKSPACE_HEADER = 'x-bh-workspace';

/** What a client declares through headers, one column each. */
export interface DeclaredClient {
  readonly harness: string | null;
  readonly model: string | null;
  /** `X-BH-Workspace`, stored as `agent_name`. */
  readonly agentName: string | null;
}

function headerValue(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value === undefined || value === '' ? null : value;
}

/** Reads the three documented headers; blank values count as absent. */
export function declaredClientOf(headers: Headers): DeclaredClient {
  return {
    harness: headerValue(headers, HARNESS_HEADER),
    model: headerValue(headers, MODEL_HEADER),
    agentName: headerValue(headers, WORKSPACE_HEADER),
  };
}

/**
 * The client identity a tool call carries: `clientInfo` (as the SDK recorded it at `initialize`)
 * merged with the declared headers; `null` when the client said nothing.
 */
export function sessionClientOf(
  clientInfo: { readonly name?: string; readonly version?: string } | undefined,
  declared: DeclaredClient | undefined,
): SessionClientInfo | null {
  return clientInfoOrNull({
    name: clientInfo?.name ?? null,
    version: clientInfo?.version ?? null,
    agentName: declared?.agentName ?? null,
    model: declared?.model ?? null,
  });
}
