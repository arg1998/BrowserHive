/** @module domain/session/client-info — the self-reported identity of the MCP client that launched a session (spec 02 §1.4, D-30): shown in the dashboard, never used for access control or any other decision. */

/** What a client said about itself (`clientInfo`, `X-BH-*` headers, `_meta`, the stdio environment) as resolved for one call. */
export interface SessionClientInfo {
  /** `clientInfo.name`. */
  readonly name: string | null;
  /** `clientInfo.version`. */
  readonly version: string | null;
  /** The workspace, under its legacy name (`mcp_connections.agent_name`). */
  readonly agentName: string | null;
  /** Declared model. */
  readonly model: string | null;
  /** `clientInfo.title`. */
  readonly title?: string | null;
  /** Declared workspace (same value as `agentName`). */
  readonly workspace?: string | null;
  /** Where `model` came from (`header|env|meta`). */
  readonly modelSource?: string | null;
  /** Resolved harness slug. */
  readonly harness?: string | null;
  /** How `harness` was recognised. */
  readonly harnessSource?: string | null;
  /** Requested protocol version. */
  readonly protocolVersion?: string | null;
  /** The capped meta bag. */
  readonly meta?: Readonly<Record<string, string>>;
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined;
}

/**
 * The info, or `null` when the client reported nothing at all (so "unknown" is one value, not a
 * record of nulls): no name, version, title, workspace or model, no meta, and harness `unknown`.
 */
export function clientInfoOrNull(info: SessionClientInfo): SessionClientInfo | null {
  const silent =
    blank(info.name) &&
    blank(info.version) &&
    blank(info.title) &&
    blank(info.agentName) &&
    blank(info.workspace) &&
    blank(info.model) &&
    (blank(info.harness) || info.harness === 'unknown') &&
    Object.keys(info.meta ?? {}).length === 0;
  return silent ? null : info;
}
