/** @module domain/session/client-info — the self-reported identity of the MCP client that launched a session (spec 02 §1.4): shown in the dashboard, never used for access control. */

/** What a client said about itself: `initialize.clientInfo` plus the optional `X-BH-*` headers. */
export interface SessionClientInfo {
  /** `clientInfo.name`. */
  readonly name: string | null;
  /** `clientInfo.version`. */
  readonly version: string | null;
  /** `X-BH-Workspace` (stored as `mcp_connections.agent_name`). */
  readonly agentName: string | null;
  /** `X-BH-Agent-Model`. */
  readonly model: string | null;
}

/** The info, or `null` when the client said nothing at all (so "unknown" is one value, not four nulls). */
export function clientInfoOrNull(info: SessionClientInfo): SessionClientInfo | null {
  return info.name === null &&
    info.version === null &&
    info.agentName === null &&
    info.model === null
    ? null
    : info;
}
