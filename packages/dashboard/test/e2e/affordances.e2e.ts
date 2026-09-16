/** @module dashboard/test/e2e/affordances.e2e — real-browser guards: a focused control paints a 2px outline, and the pointer over a row's URL text hits the row link; skips cleanly without a daemon */
import { expect, type Page, test } from '@playwright/test';

const baseUrl = process.env['BROWSERHIVE_E2E_URL'];
const seedPassword = process.env['BROWSERHIVE_E2E_PASSWORD'];
const rotatedPassword = `${seedPassword ?? ''}-rotated-e2e`;

/** Signs in with the seed or, when an earlier spec rotated it, the rotated password. */
async function signIn(page: Page): Promise<void> {
  for (const password of [seedPassword ?? '', rotatedPassword]) {
    const response = await page.request.post('/api/v1/auth/login', {
      data: { password },
      headers: { origin: baseUrl ?? '' },
    });
    if (response.ok()) return;
  }
  throw new Error('sign-in failed with both the seed and the rotated password');
}

test.describe('affordances', () => {
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'BROWSERHIVE_E2E_URL / BROWSERHIVE_E2E_PASSWORD not set',
  );

  test('keyboard focus paints a visible 2px ring on buttons, toggles and tabs', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/sessions');
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
    const offenders: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el === null || el === document.body || el.matches('input, textarea')) return null;
        const style = getComputedStyle(el);
        return {
          name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName,
          ok: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2,
        };
      });
      if (stop !== null && !stop.ok) offenders.push(stop.name);
    }
    expect(offenders).toEqual([]);
  });

  test('a click on a row URL opens the row', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'tables render as cards on phones');
    await signIn(page);
    await page.goto('/websites');
    const url = page.locator('tbody [data-url]').first();
    await url.waitFor({ timeout: 10_000 }).catch(() => undefined);
    test.skip((await url.count()) === 0, 'no page visits in this data dir');
    const box = await url.boundingBox();
    if (box === null) throw new Error('URL cell not laid out');
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-row-link') ?? false,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit).toBe(true);
  });
});
