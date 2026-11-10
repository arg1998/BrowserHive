/** @module dashboard/test/e2e/templates.e2e — the templates journey of spec 13 §17 T1a against a running template daemon (`packages/browserhive/test/e2e/template-server.ts` on a display): create a template against the fixture sites with the CLI, sign in by typing into its window (xdotool), press Enter, then launch from an agent over MCP and find the session signed in; skips cleanly without that daemon */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expect, type Page, test } from '@playwright/test';

const baseUrl = process.env['BROWSERHIVE_E2E_TEMPLATES_URL'];
const seedPassword = process.env['BROWSERHIVE_E2E_TEMPLATES_PASSWORD'];
const rotatedPassword = `${seedPassword ?? ''}-rotated-e2e`;
const REPO = process.cwd();
const SITE = 'shop.test';

/** Signs in over REST (rotating the seed password once) and returns the session cookie value. */
async function operatorCookie(page: Page): Promise<string> {
  const headers = { origin: baseUrl ?? '' };
  for (const password of [seedPassword ?? '', rotatedPassword]) {
    const response = await page.request.post(`${baseUrl}/api/v1/auth/login`, {
      data: { password },
      headers,
    });
    if (!response.ok()) continue;
    const body = (await response.json()) as { must_change_password?: boolean };
    if (body.must_change_password === true) {
      await page.request.post(`${baseUrl}/api/v1/auth/change-password`, {
        data: { current_password: password, new_password: rotatedPassword },
        headers,
      });
      await page.request.post(`${baseUrl}/api/v1/auth/login`, {
        data: { password: rotatedPassword },
        headers,
      });
    }
    const cookie = (await page.context().cookies()).find((c) => c.name === 'browserhive_session');
    if (cookie !== undefined) return cookie.value;
  }
  throw new Error('operator sign-in failed');
}

/** `browserhive templates …` from source, without the e2e variables (the CLI refuses unknown ones). */
function cli(args: readonly string[]): ChildProcessWithoutNullStreams {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('BROWSERHIVE_')),
  );
  return spawn('bun', ['packages/browserhive/src/bin.ts', 'templates', ...args], {
    cwd: REPO,
    env,
  });
}

/** Resolves with everything `child` printed once `pattern` appears, or rejects after `ms`. */
function waitForOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp, ms: number) {
  return new Promise<string>((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error(`no ${pattern} in:\n${text}`)), ms);
    const read = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (pattern.test(text)) {
        clearTimeout(timer);
        done(text);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
}

/** Types into the recording window as the operator would: its site tab, user name, password, Enter. */
function signInByKeyboard(): void {
  const found = execFileSync(
    'xdotool',
    ['search', '--sync', '--onlyvisible', '--name', `Sign in to ${SITE}`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const window = found.trim().split('\n')[0] ?? '';
  const xdo = (...args: string[]) => execFileSync('xdotool', args, { timeout: 15_000 });
  xdo('windowfocus', '--sync', window);
  // The first tab carries the instructions; the site's sign-in form is the second.
  xdo('key', '--clearmodifiers', 'ctrl+2');
  xdo('sleep', '1');
  xdo('type', '--delay', '40', 'operator');
  xdo('key', 'Tab');
  xdo('type', '--delay', '40', 'correct horse battery staple');
  xdo('key', 'Return');
  xdo('sleep', '2');
}

test.describe('session templates', () => {
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'needs the template daemon (BROWSERHIVE_E2E_TEMPLATES_URL) on a display',
  );

  test('create with the CLI, sign in through the window, launch from an agent', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'one browser journey is enough');
    test.setTimeout(180_000);
    const cookie = await operatorCookie(page);
    const create = cli([
      'create',
      'shop',
      '--sites',
      SITE,
      '--allPrincipals',
      '--url',
      baseUrl ?? '',
      '--cookie',
      cookie,
      '--timeout',
      '3m',
    ]);
    const exited = new Promise<number | null>((done) => create.on('close', done));
    await waitForOutput(create, /press Enter/i, 60_000);
    signInByKeyboard();
    const finished = waitForOutput(create, /is ready/i, 60_000);
    create.stdin.write('\n');
    const output = await finished;
    expect(await exited).toBe(0);
    expect(output).toContain(SITE);

    // The agent's side: list, launch, and the site knows who is signed in.
    const client = new Client({ name: 'e2e-templates', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)) as Transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError === true) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
      return (result.structuredContent ?? {}) as Record<string, unknown>;
    };
    const listed = (await call('list_templates', {}))['templates'] as { name: string }[];
    expect(listed.map((t) => t.name)).toContain('shop');
    const launched = await call('launch_session', { slug: 'e2e', template: 'shop' });
    const sessionId = String(launched['session_id']);
    await call('navigate', { session_id: sessionId, url: `https://${SITE}/account` });
    const content = await call('get_content', { session_id: sessionId });
    expect(JSON.stringify(content)).toContain(`Signed in to ${SITE} as operator`);
    const cookies = await call('get_cookies', { session_id: sessionId });
    expect(cookies['sealed']).toBe(true);
    await call('close_session', { session_id: sessionId });
    await client.close();
  });
});
