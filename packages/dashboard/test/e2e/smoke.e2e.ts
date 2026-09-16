/** @module dashboard/test/e2e/smoke.e2e — operator journey against a running daemon (`BROWSERHIVE_E2E_URL`) seeded with `bun scripts/e2e-seed.ts`; skips cleanly when unset */
import { expect, type Page, test } from '@playwright/test';

const baseUrl = process.env['BROWSERHIVE_E2E_URL'];
const seedPassword = process.env['BROWSERHIVE_E2E_PASSWORD'];
/** The password the journey rotates the seed to (spec 03 §3.4: first login forces a change). */
const rotatedPassword = `${seedPassword ?? ''}-rotated-e2e`;

/**
 * Signs in, rotating the seed password on the first run; later runs use the rotated password.
 * Labels match exactly: each password field has a "Show password" toggle whose name contains "password".
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(seedPassword ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Leaves /login on success; stays there (with an error) when the seed was already rotated.
  await page
    .waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 10_000 })
    .catch(() => undefined);
  if (page.url().endsWith('/change-password')) {
    await page.getByLabel('Current (seed) password', { exact: true }).fill(seedPassword ?? '');
    await page.getByLabel('New password', { exact: true }).fill(rotatedPassword);
    await page.getByLabel('Confirm new password', { exact: true }).fill(rotatedPassword);
    await page.getByRole('button', { name: 'Change password' }).click();
  } else if (page.url().endsWith('/login')) {
    // The seed was already rotated by an earlier project in this run.
    await page.getByLabel('Password', { exact: true }).fill(rotatedPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page).toHaveURL(/\/overview$/);
}

test.describe('smoke', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'BROWSERHIVE_E2E_URL / BROWSERHIVE_E2E_PASSWORD not set',
  );

  test('login → forced password change → overview', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
  });

  test('sessions list → session detail → timeline', async ({ page }) => {
    await signIn(page);
    await page.goto('/sessions');
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
    const link = page.getByRole('link', { name: /demo/ }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/sessions\/demo-/);
    await expect(page.getByText(/wikipedia\.org/).first()).toBeVisible();
  });

  test('websites, logs and system pages render live data', async ({ page }) => {
    await signIn(page);
    await page.goto('/websites');
    await expect(page.getByText(/example\.com/).first()).toBeVisible();
    await page.goto('/logs');
    await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
    await page.goto('/system');
    await expect(page.getByText('1.4.2').first()).toBeVisible();
  });
});
