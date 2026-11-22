/** @module dashboard/test/e2e/site-packs.e2e — site packs in a real Chrome against the template daemon (spec 13 §11.4, §17 T3a): the Site packs page lists the bundled packs, a pack's page reads as text, and wizard step 2 shows the catalog, and (T3b) the history shows a classification chip in words; axe finds no serious or critical violation on them in either theme. Skips without that daemon */
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
        sessionStorage.setItem(
          'bh.templateDraft',
          JSON.stringify({ name: 'packs-e2e', sites: [] }),
        );
      }, theme);

      await page.goto(`${baseUrl}/site-packs`);
      const table = page.getByRole('region', { name: 'Site packs' });
      // Each row is one link named after its pack.
      await expect(table.getByRole('link', { name: 'LinkedIn', exact: true })).toBeAttached();
      await expect(table.getByRole('link', { name: 'GitHub', exact: true })).toBeAttached();
      await expect(page.getByRole('heading', { name: 'Registry and sources' })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.goto(`${baseUrl}/site-packs/linkedin.com`);
      await expect(page.getByRole('heading', { level: 1, name: 'LinkedIn' })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Guards' })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.goto(`${baseUrl}/templates/new?step=2`);
      await expect(page.getByRole('heading', { name: 'Sites BrowserHive knows' })).toBeVisible();
      // Pack strings are wrapped in Unicode isolates (U+2068 … U+2069, review S-H4).
      await page.getByRole('button', { name: /^Add \u2068?GitHub\u2069?$/ }).click();
      const added = page.getByRole('button', { name: /^Remove \u2068?GitHub\u2069?$/ });
      await expect(added).toHaveAttribute('aria-pressed', 'true');
      // A version approved earlier (the registry update below, on a rerun) reads "Uses GitHub vN".
      await expect(
        page.getByText(/(Adding this site approves|Uses) \u2068?GitHub\u2069? v\d+/),
      ).toBeVisible();
      await expect(page.getByLabel('Add a site')).toBeVisible();
      expect(await violations(page)).toEqual([]);
      // The card is a toggle: pressing it again takes the site out.
      await added.click();
      await expect(
        page.getByRole('button', { name: /^Add \u2068?GitHub\u2069?$/ }),
      ).toHaveAttribute('aria-pressed', 'false');
      await expect(
        page.getByText(/(Adding this site approves|Uses) \u2068?GitHub\u2069?/),
      ).toHaveCount(0);
    });
  }

  test('a registry update: Check now, Download & review, Apply (T4b)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'one browser is enough');
    await operatorCookie(page);
    const headers = { origin: baseUrl ?? '' };
    // The daemon's signed fake registry lists GitHub v3. Following the pack lists it under Updates
    // available (no template uses it here, so Auto would not follow it).
    const follow = await page.request.put(`${baseUrl}/api/v1/site-packs/github.com/follow`, {
      data: { follow: true },
      headers,
    });
    expect(follow.ok()).toBe(true);
    const before = (await (
      await page.request.get(`${baseUrl}/api/v1/site-packs/github.com`)
    ).json()) as { view: { approved: { source: string } | null } };
    await page.goto(`${baseUrl}/site-packs`);
    const table = page.getByRole('region', { name: 'Site packs' });
    if (before.view.approved?.source !== 'remote') {
      await page.getByRole('button', { name: 'Check now' }).click();
      await expect(page.getByText(/Index \d+ verified|Up to date/).first()).toBeVisible();
      const updates = page.getByRole('region', { name: /Updates available/ });
      const card = updates
        .locator('article')
        .filter({ has: page.getByRole('heading', { level: 3, name: /GitHub/ }) });
      await expect(card).toBeVisible();
      await expect(
        card.getByText(/browserhive\.ai registry · key .+ · signature verified · index \d+/),
      ).toBeVisible();
      const download = card.getByRole('button', { name: /Download & review/ });
      if (await download.isVisible()) {
        await expect(card.getByText('Not downloaded', { exact: true })).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await download.click();
      }
      // Downloaded and verified: classified, its fields shown, focus back on the card.
      await expect(card.locator('[data-classification]').first()).toBeVisible();
      await expect(card.getByRole('button', { name: 'Apply…' })).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await card.getByRole('button', { name: 'Apply…' }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await dialog.getByRole('button', { name: /^Apply v\d+$/ }).click();
      await expect(card).toHaveCount(0);
    }
    // Applied from the registry: the table names where it came from.
    const row = table.getByRole('row').filter({ hasText: 'GitHub' });
    await expect(
      row.getByText('browserhive.ai registry', { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
    expect(await violations(page)).toEqual([]);
  });

  test('a classification chip in the history, in words (T3b)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'one browser is enough');
    await operatorCookie(page);
    const headers = { origin: baseUrl ?? '' };
    const pack = {
      schema: 1,
      id: 'e2e-pack.test',
      version: 1,
      min_client: '0.1.0',
      title: 'E2E pack',
      domains: ['e2e-pack.test'],
      sign_in: { url: { host: 'www.e2e-pack.test', path: '/login' }, human_only: false },
      signed_in: {
        probe: { host: 'www.e2e-pack.test', path: '/account' },
        kind: 'redirect',
        signed_out_redirects: ['www.e2e-pack.test/login*'],
      },
      guards: [
        {
          id: 'logout',
          kind: 'logout',
          match: { url: 'www.e2e-pack.test/logout' },
          action: 'block',
        },
      ],
      write_policy: { default: 'confirm', stance: 'prohibited' },
    };
    const imported = await page.request.post(`${baseUrl}/api/v1/site-packs/import`, {
      data: { text: `${JSON.stringify(pack, null, 2)}\n` },
      headers,
    });
    expect(imported.ok()).toBe(true);
    const diff = await page.request.get(`${baseUrl}/api/v1/site-packs/e2e-pack.test/diff?to=local`);
    const sha = ((await diff.json()) as { to: { sha256: string } }).to.sha256;
    const approved = await page.request.post(
      `${baseUrl}/api/v1/site-packs/e2e-pack.test/approve-local`,
      { data: { sha256: sha }, headers },
    );
    expect(approved.ok()).toBe(true);
    await page.goto(`${baseUrl}/site-packs?tab=history`);
    const history = page.getByRole('region', { name: 'Pack history' });
    // The approval of a local file reads "Local override": a chip with words and an icon.
    const chip = history.locator('[data-classification="local_override"]').first();
    await expect(chip).toHaveText('Local override');
    await expect(chip.locator('svg')).toBeAttached();
    expect(await violations(page)).toEqual([]);
  });
});
