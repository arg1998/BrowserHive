/** @module dashboard/test/e2e/template-helpers — shared pieces of the templates journeys (spec 13 §17 T1a, T1c) against the template daemon (`packages/browserhive/test/e2e/template-server.ts` on a display): the operator's cookie, the CLI from source, the display's windows, typing a sign-in into the template's window with xdotool, and an MCP agent */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Page } from '@playwright/test';

export const baseUrl = process.env['BROWSERHIVE_E2E_TEMPLATES_URL'];
export const seedPassword = process.env['BROWSERHIVE_E2E_TEMPLATES_PASSWORD'];
const rotatedPassword = `${seedPassword ?? ''}-rotated-e2e`;
const REPO = process.cwd();
export const SITE = 'shop.test';

/** Signs in over REST (rotating the seed password once) and returns the session cookie value. */
export async function operatorCookie(page: Page): Promise<string> {
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
export function cli(args: readonly string[]): ChildProcessWithoutNullStreams {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('BROWSERHIVE_')),
  );
  return spawn('bun', ['packages/browserhive/src/bin.ts', 'templates', ...args], {
    cwd: REPO,
    env,
  });
}

/** Resolves with everything `child` printed once `pattern` appears, or rejects after `ms`. */
export function waitForOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp, ms: number) {
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
export function signInByKeyboard(shots: (name: string) => string, site = SITE): string {
  const log: string[] = [];
  execFileSync('xdotool', ['search', '--sync', '--onlyvisible', '--name', 'BrowserHive'], {
    timeout: 30_000,
  });
  const xdo = (...args: string[]) =>
    execFileSync('xdotool', args, { encoding: 'utf8', timeout: 15_000 }).trim();
  log.push(`windows: ${JSON.stringify(windows())}`);
  const marked = windows().find((w) => w.name.includes(`[BrowserHive] Sign in to ${site}`));
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

/** An MCP agent on the template daemon; `call` throws on a tool error. */
export async function agent(name: string) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)) as Transport);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError === true) throw new Error(`${tool}: ${JSON.stringify(result.content)}`);
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  };
  return { call, close: () => client.close() };
}
