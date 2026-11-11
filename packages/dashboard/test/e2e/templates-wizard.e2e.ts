/** @module dashboard/test/e2e/templates-wizard.e2e — the dashboard's templates journey (spec 13 §17 T1c) against the template daemon on a display: the new-template wizard creates a template against a fixture site, opens the sign-in window, the test signs in by typing into that window (xdotool), presses I'm signed in, finishes, and an agent launches a session from the template over MCP and finds it signed in; skips cleanly without that daemon */
import { expect, type Page, test } from '@playwright/test';
import {
  agent,
  baseUrl,
  operatorCookie,
  SITE,
  seedPassword,
  signInByKeyboard,
} from './template-helpers.ts';

/** Press **I'm signed in** once and check the site's state reads exactly "Signed in". */
async function confirmSignedIn(page: Page, site: string): Promise<void> {
  await page.getByRole('button', { name: `I’m signed in: ${site}` }).click();
  const row = page
    .getByRole('list', { name: 'Sites' })
    .getByRole('listitem')
    .filter({ hasText: site });
  await expect(row.locator('[data-state]')).toHaveAttribute('data-state', 'signed_in', {
    timeout: 10_000,
  });
  await expect(row.getByRole('alert')).toHaveCount(0);
}

test.describe('session templates in the dashboard', () => {
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'needs the template daemon (BROWSERHIVE_E2E_TEMPLATES_URL) on a display',
  );

  test('wizard, sign in through the window, Finish, launch from an agent', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'one browser journey is enough');
    test.setTimeout(180_000);
    await operatorCookie(page);
    // Unique per attempt: a retry or a rerun against the same daemon finds the earlier template.
    const name = `wizard-${Math.random().toString(36).slice(2, 8)}`;

    await page.goto(`${baseUrl}/templates/new`);
    await page.getByLabel('Display name').fill(`Shop wizard ${info.retry}`);
    await page.getByLabel('Name for agents').fill(name);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/step=2/);
    await page.getByLabel('Add a site').fill(`https://${SITE}/`);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Identity and network' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Access' })).toBeVisible();
    await page.getByRole('button', { name: 'Create and sign in' }).click();
    await expect(page).toHaveURL(/step=5&template=tp-/);

    await page.getByRole('button', { name: /Open the sign-in window|Open browser on/ }).click();
    await expect(page.getByText(/The sign-in window is open/)).toBeVisible({ timeout: 60_000 });
    const display = signInByKeyboard((file) => info.outputPath(file));
    try {
      await confirmSignedIn(page, SITE);
    } catch (error) {
      throw new Error(`${String(error)}\n${display}`);
    }
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Finish signing in?' });
    await dialog.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(page.getByText(`Shop wizard ${info.retry} is ready`, { exact: true })).toBeVisible(
      {
        timeout: 30_000,
      },
    );

    // The template page shows the site signed in.
    await page.getByRole('link', { name: 'Open the template' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: `Shop wizard ${info.retry}` }),
    ).toBeVisible();
    const card = page.locator(`[data-site="${SITE}"]`);
    await expect(card.getByText('Signed in', { exact: true })).toBeVisible();

    // The agent's side: list, launch, and the site knows who is signed in.
    const { call, close } = await agent('e2e-templates-wizard');
    const listed = (await call('list_templates', {}))['templates'] as { name: string }[];
    expect(listed.map((t) => t.name)).toContain(name);
    const launched = await call('launch_session', { slug: 'e2e-wizard', template: name });
    const sessionId = String(launched['session_id']);
    await call('navigate', { session_id: sessionId, url: `https://${SITE}/account` });
    const content = await call('get_content', { session_id: sessionId });
    expect(JSON.stringify(content)).toContain(`Signed in to ${SITE} as operator`);
    await call('close_session', { session_id: sessionId });
    await close();
  });
});
