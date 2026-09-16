/**
 * @module scripts/dev-seed-activity — fill a local dev daemon with realistic dashboard data over MCP.
 *
 * Usage: `bun scripts/dev-seed-activity.ts [baseUrl] [--keep-live]`
 * Default base URL: http://127.0.0.1:9877.
 *
 * It creates closed sessions that have navigations, tool errors and screenshots. With `--keep-live`
 * it also leaves one session open, visiting pages every few seconds, so the live view has changing
 * frames. The script then keeps running until it is killed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:9877';
const keepLive = process.argv.includes('--keep-live');

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)) as Transport);
  return client;
}

function idOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const structured = (result as { structuredContent?: { session_id?: string } }).structuredContent;
  if (structured?.session_id) return structured.session_id;
  const text =
    (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
      ?.text ?? '{}';
  return (JSON.parse(text) as { session_id: string }).session_id;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch {
    return undefined;
  }
}

const PAGES = [
  'https://example.com/',
  'https://the-internet.herokuapp.com/',
  'https://the-internet.herokuapp.com/login',
  'https://the-internet.herokuapp.com/tables',
  'https://news.ycombinator.com/',
  'https://en.wikipedia.org/wiki/Web_browser',
];

async function closedSession(slug: string, pages: string[], withErrors: boolean) {
  const client = await connect(`seed-${slug}`);
  const launched = await call(client, 'launch_session', { slug });
  if (!launched) return;
  const id = idOf(launched);
  for (const url of pages) {
    await call(client, 'navigate', { session_id: id, url });
    await call(client, 'get_content', { session_id: id });
  }
  await call(client, 'screenshot', { session_id: id });
  if (withErrors) {
    await call(client, 'click', { session_id: id, selector: '#does-not-exist', timeout_ms: 1500 });
    await call(client, 'fill', {
      session_id: id,
      selector: 'input[name=nope]',
      value: 'x',
      timeout_ms: 1500,
    });
  }
  await call(client, 'close_session', { session_id: id });
  await client.close();
  console.log(`closed session ${id}`);
}

await closedSession('checkout-flow-audit', PAGES.slice(0, 4), true);
await closedSession('docs-crawler', PAGES.slice(4), false);
await closedSession('login-smoke', PAGES.slice(1, 3), true);

if (keepLive) {
  const client = await connect('seed-live');
  const launched = await call(client, 'launch_session', { slug: 'live-research-agent' });
  if (!launched) throw new Error('launch_session failed');
  const id = idOf(launched);
  console.log(`live session ${id} (Ctrl+C to stop)`);
  let i = 0;
  const stop = async () => {
    await call(client, 'close_session', { session_id: id });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (;;) {
    await call(client, 'navigate', { session_id: id, url: PAGES[i % PAGES.length] });
    await call(client, 'scroll', { session_id: id, direction: 'down', amount: 600 });
    if (i % 3 === 2)
      await call(client, 'click', { session_id: id, selector: '#missing', timeout_ms: 1000 });
    if (i % 4 === 0) await call(client, 'screenshot', { session_id: id });
    i++;
    await Bun.sleep(4000);
  }
}
