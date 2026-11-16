/** @module dashboard/test/e2e/templates.e2e — the templates journey of spec 13 §17 T1a against a running template daemon (`packages/browserhive/test/e2e/template-server.ts` on a display): create a template against the fixture sites with the CLI, sign in by typing into its window (xdotool), press Enter, then launch from an agent over MCP and find the session signed in; skips cleanly without that daemon */
import { expect, test } from '@playwright/test';
import {
  agent,
  baseUrl,
  cli,
  operatorCookie,
  SITE,
  seedPassword,
  signInByKeyboard,
  waitForOutput,
} from './template-helpers.ts';

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
    const { call, close } = await agent('e2e-templates');
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
    await close();
  });
});
