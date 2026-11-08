/** @module dashboard/test/e2e/saved-logins.e2e — the Saved logins journey against a running daemon seeded with `bun scripts/e2e-seed.ts`: the seeded login is listed with its kind, owner and a link to its source session; one login per project is deleted through the confirmation, which names it, its owner and that restored sessions keep running; skips cleanly without a daemon */
import { expect, type Page, test } from '@playwright/test';

const baseUrl = process.env['BROWSERHIVE_E2E_URL'];
const seedPassword = process.env['BROWSERHIVE_E2E_PASSWORD'];
const rotatedPassword = `${seedPassword ?? ''}-rotated-e2e`;

/** Signs in over REST with the seed or the rotated password (rotating the seed when needed). */
async function signIn(page: Page): Promise<void> {
  const headers = { origin: baseUrl ?? '' };
  for (const password of [seedPassword ?? '', rotatedPassword]) {
    const response = await page.request.post('/api/v1/auth/login', { data: { password }, headers });
    if (!response.ok()) continue;
    const body = (await response.json()) as { must_change_password?: boolean };
    if (body.must_change_password === true) {
      const changed = await page.request.post('/api/v1/auth/change-password', {
        data: { current_password: password, new_password: rotatedPassword },
        headers,
      });
      if (!changed.ok()) throw new Error(`seed rotation failed: ${changed.status()}`);
      const again = await page.request.post('/api/v1/auth/login', {
        data: { password: rotatedPassword },
        headers,
      });
      if (!again.ok()) throw new Error(`sign-in after rotation failed: ${again.status()}`);
    }
    return;
  }
  throw new Error('sign-in failed with both the seed and the rotated password');
}

test.describe('saved logins', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'BROWSERHIVE_E2E_URL / BROWSERHIVE_E2E_PASSWORD not set',
  );

  test('lists the seeded login and deletes one after confirming', async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto('/saved-logins');
    await expect(page.getByRole('heading', { level: 1, name: 'Saved logins' })).toBeVisible();
    // The table on desktop, cards on a phone: only one of them is visible.
    const visible = (text: string) =>
      page.getByText(text, { exact: true }).filter({ visible: true });
    await expect(visible('e2e-login').first()).toBeVisible();
    await expect(visible('Cookies & storage').first()).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'demo', exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();

    const name = `e2e-delete-${testInfo.project.name}`;
    const remove = page
      .getByRole('button', { name: `Delete saved login ${name} of local` })
      .filter({ visible: true });
    // A retry after a delete that already went through finds nothing left to delete.
    if ((await remove.count()) === 0) return;
    await remove.first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(`Delete saved login ${name}?`)).toBeVisible();
    await expect(dialog.getByText(/Owner: local\./)).toBeVisible();
    await expect(
      dialog.getByText(/Sessions already restored from it keep running\./),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(`Saved login ${name} deleted`).first()).toBeVisible();
    await expect(visible(name)).toHaveCount(0);
    await expect(visible('e2e-login').first()).toBeVisible();
  });
});
