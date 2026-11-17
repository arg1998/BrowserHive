/** @module dashboard/test/e2e/site-packs.e2e — site packs in a real Chrome against the template daemon (spec 13 §11.4, §17 T3a): the Site packs page lists the bundled packs, a pack's page reads as text, and wizard step 2 shows the catalog; axe finds no serious or critical violation on them in either theme. Skips without that daemon */
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { baseUrl, operatorCookie, seedPassword } from './template-helpers.ts';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** Serious and critical axe violations, as readable lines. */
async function violations(page: Page): Promise<string[]> {
  await page.mouse.move(0, 0);
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
      null,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (o: unknown) => Promise<{
            violations: { id: string; impact: string; nodes: { target: string[] }[] }[];
          }>;
        };
      }
    ).axe;
    const result = await axe.run({
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

test.describe('site packs in the dashboard', () => {
  test.use({ bypassCSP: true });
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'needs the template daemon (BROWSERHIVE_E2E_TEMPLATES_URL)',
  );

  for (const theme of ['light', 'dark'] as const) {
    test(`the packs page, a pack and the wizard catalog (${theme})`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'one browser is enough');
      await operatorCookie(page);
      await page.addInitScript((t) => {
        localStorage.setItem('bh.theme', t);
        localStorage.setItem('bh.templateDraft', JSON.stringify({ name: 'packs-e2e', sites: [] }));
      }, theme);

      await page.goto(`${baseUrl}/site-packs`);
      const table = page.getByRole('region', { name: 'Site packs' });
      // Each row is one link named after its pack.
      await expect(table.getByRole('link', { name: 'LinkedIn', exact: true })).toBeAttached();
      await expect(table.getByRole('link', { name: 'GitHub', exact: true })).toBeAttached();
      await expect(page.getByRole('heading', { name: 'Where packs come from' })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.goto(`${baseUrl}/site-packs/linkedin.com`);
      await expect(page.getByRole('heading', { level: 1, name: 'LinkedIn' })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Guards' })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.goto(`${baseUrl}/templates/new?step=2`);
      await expect(page.getByRole('heading', { name: 'Sites BrowserHive knows' })).toBeVisible();
      // Pack strings are wrapped in Unicode isolates (U+2068 … U+2069, review S-H4).
      await page.getByRole('button', { name: /^Add \u2068?GitHub\u2069?$/ }).click();
      await expect(
        page.getByRole('button', { name: /^\u2068?GitHub\u2069?: added$/ }),
      ).toBeVisible();
      await expect(
        page.getByText(/Adding this site approves \u2068?GitHub\u2069? v\d+/),
      ).toBeVisible();
      await expect(page.getByLabel('Add a site')).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }
});
