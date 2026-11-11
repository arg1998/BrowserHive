/** @module dashboard/test/e2e/templates-axe.e2e — axe-core in a real Chrome (spec 04 §1 principle 5, spec 13 §17 T1c): the templates list, every wizard step, the sign-in step and every tab of the template page, in light and dark, against the template daemon; no serious or critical violation (colour contrast and link-in-text-block included, which happy-dom cannot compute). Skips without that daemon */
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { baseUrl, operatorCookie, SITE, seedPassword } from './template-helpers.ts';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const TABS = ['sites', 'sessions', 'versions', 'access', 'settings', 'activity'] as const;

/** Serious and critical violations on the page, as readable lines. */
async function violations(page: Page): Promise<string[]> {
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

test.describe('templates pages pass axe in Chrome', () => {
  // The dashboard's CSP allows only its own scripts; axe is injected by the test.
  test.use({ bypassCSP: true });
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'needs the template daemon (BROWSERHIVE_E2E_TEMPLATES_URL)',
  );

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} theme`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'one browser is enough');
      test.setTimeout(120_000);
      await operatorCookie(page);
      await page.addInitScript((t) => {
        localStorage.setItem('bh.theme', t);
        // A draft that reaches every step (the wizard sends deep links back to an unfinished step).
        localStorage.setItem(
          'bh.templateDraft',
          JSON.stringify({ name: 'axe-draft', sites: ['shop.test'], access: 'all' }),
        );
      }, theme);
      const name = `axe-${Math.random().toString(36).slice(2, 8)}`;
      const created = await page.request.post(`${baseUrl}/api/v1/templates`, {
        data: { name, display_name: `Axe ${theme}`, sites: [{ site_id: SITE }] },
        headers: { origin: baseUrl ?? '' },
      });
      expect(created.ok()).toBe(true);
      const id = ((await created.json()) as { template: { template_id: string } }).template
        .template_id;
      const urls = [
        '/templates',
        '/templates/new?step=1',
        '/templates/new?step=2',
        '/templates/new?step=3',
        '/templates/new?step=4',
        `/templates/new?step=5&template=${id}`,
        ...TABS.map((tab) => `/templates/${id}?tab=${tab}`),
      ];
      const found: string[] = [];
      for (const url of urls) {
        await page.goto(`${baseUrl}${url}`);
        await page.waitForLoadState('networkidle');
        for (const line of await violations(page)) found.push(`${url} ${line}`);
      }
      expect(found).toEqual([]);
    });
  }
});
