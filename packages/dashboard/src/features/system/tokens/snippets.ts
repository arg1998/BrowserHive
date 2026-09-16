/** @module features/system/tokens/snippets — ready-to-paste client snippets for a freshly issued token: Streamable HTTP MCP config and a curl `initialize` probe (docs/guide/mcp-clients.md) */

/** The MCP endpoint for a dashboard origin (one listener serves the dashboard and `/mcp`). */
export function mcpUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

/** `mcpServers` JSON for clients that speak Streamable HTTP. */
export function mcpConfigSnippet(origin: string, token: string): string {
  const config = {
    mcpServers: {
      browserhive: {
        type: 'http',
        url: mcpUrl(origin),
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/** A curl `initialize` request that proves the token works (200) or not (401). */
export function curlSnippet(origin: string, token: string): string {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'curl', version: '0' },
    },
  });
  return [
    `curl -i ${mcpUrl(origin)} \\`,
    `  -H 'Authorization: Bearer ${token}' \\`,
    `  -H 'Accept: application/json, text/event-stream' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${body}'`,
  ].join('\n');
}
