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

/** Visible X windows and their names (the display's view of the template's browser). */
function windows(): { id: string; name: string }[] {
  let ids: string[] = [];
  try {
    ids = execFileSync('xdotool', ['search', '--onlyvisible', '--name', '.'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((id) => id !== '');
  } catch {
    return [];
  }
  return ids.map((id) => {
    try {
      const name = execFileSync('xdotool', ['getwindowname', id], { encoding: 'utf8' }).trim();
      return { id, name };
    } catch {
      return { id, name: '' };
    }
  });
}

/** Saves a picture of the whole display next to the test's results (CI uploads them on failure). */
function snap(path: string): void {
  try {
    execFileSync('import', ['-window', 'root', path], { timeout: 15_000 });
  } catch {
    // No ImageMagick: the window names in the log still say what was on screen.
  }
}

/**
 * Types into the template's sign-in window as the operator would: the site's tab (the second tab of
 * the window whose first tab carries the `[BrowserHive] Sign in to …` marker), user name, Tab,
 * password, Enter. Returns what the display showed, for the failure message.
 */
function signInByKeyboard(shots: (name: string) => string): string {
  const log: string[] = [];
  execFileSync('xdotool', ['search', '--sync', '--onlyvisible', '--name', 'BrowserHive'], {
    timeout: 30_000,
  });
  const xdo = (...args: string[]) =>
    execFileSync('xdotool', args, { encoding: 'utf8', timeout: 15_000 }).trim();
  log.push(`windows: ${JSON.stringify(windows())}`);
  const marked = windows().find((w) => w.name.includes(`[BrowserHive] Sign in to ${SITE}`));
  if (marked === undefined) return `${log.join('\n')}\nno marked window`;
  xdo('windowfocus', '--sync', marked.id);
  xdo('key', '--clearmodifiers', 'ctrl+2');
  xdo('sleep', '1');
  log.push(`after ctrl+2 focus: ${xdo('getwindowfocus', 'getwindowname')}`);
  snap(shots('before-typing.png'));
  xdo('type', '--delay', '60', 'operator');
  xdo('key', 'Tab');
  xdo('type', '--delay', '60', 'correct horse battery staple');
  xdo('key', 'Return');
  xdo('sleep', '3');
  log.push(`after submit: ${JSON.stringify(windows())}`);
  snap(shots('after-submit.png'));
  return log.join('\n');
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
    // A retry gets its own template (the first attempt's still exists).
    const name = `shop-r${info.retry}`;
    const create = cli([
      'create',
      name,
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
    const display = signInByKeyboard((file) => info.outputPath(file));
    const finished = waitForOutput(create, /is ready/i, 60_000);
    create.stdin.write('\n');
    const output = await finished;
    expect(await exited, `${output}\n${display}`).toBe(0);
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
    expect(listed.map((t) => t.name)).toContain(name);
    const launched = await call('launch_session', { slug: 'e2e', template: name });
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
