/**
 * @module scripts/e2e-seed — creates the data the dashboard e2e journey expects, over MCP.
 *
 * Usage: `bun scripts/e2e-seed.ts [baseUrl]` (default `http://127.0.0.1:9876`). The script launches
 * a `demo` session, visits example.com and a Wikipedia page, saves three logins from it (one the
 * Saved logins journey lists, one per Playwright project for it to delete), and closes the session.
 * The daemon must serve MCP without a bearer token (the default `--auth off`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const base = process.argv[2] ?? 'http://127.0.0.1:9876';
const client = new Client({ name: 'e2e-seed', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)) as Transport);

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

const launched = await call('launch_session', { slug: 'demo' });
const sessionId = String(launched['session_id']);
for (const url of ['https://example.com/', 'https://en.wikipedia.org/wiki/Web_browser']) {
  await call('navigate', { session_id: sessionId, url });
}
for (const name of ['e2e-login', 'e2e-delete-desktop', 'e2e-delete-phone']) {
  await call('save_storage_state', { session_id: sessionId, name });
}
await call('close_session', { session_id: sessionId });
await client.close();
console.log(`e2e-seed: ${sessionId} visited 2 pages and saved 3 logins`);
