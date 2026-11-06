/** @module dashboard/test/e2e/pwa.e2e — the installable dashboard (D-49, 04 §18, 09 §3.5): installability reported by Chromium itself in a persistent context, the native install prompt path, and in an ordinary context the offline worker taking control and Install app opening the instructions dialog; runs only in the `pwa` project; skips cleanly when `BROWSERHIVE_E2E_URL` is unset */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';

const baseUrl = process.env['BROWSERHIVE_E2E_URL'];
const seedPassword = process.env['BROWSERHIVE_E2E_PASSWORD'];
/** The password the journeys rotate the seed to (spec 03 §3.4: first login forces a change). */
const rotatedPassword = `${seedPassword ?? ''}-rotated-e2e`;
const AXE_PATH = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** Signs in, rotating the seed password when no earlier project did. */
async function signIn(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(seedPassword ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page
    .waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 10_000 })
    .catch(() => undefined);
  if (page.url().endsWith('/change-password')) {
    await page.getByLabel('Current (seed) password', { exact: true }).fill(seedPassword ?? '');
    await page.getByLabel('New password', { exact: true }).fill(rotatedPassword);
    await page.getByLabel('Confirm new password', { exact: true }).fill(rotatedPassword);
    await page.getByRole('button', { name: 'Change password' }).click();
  } else if (page.url().endsWith('/login')) {
    await page.getByLabel('Password', { exact: true }).fill(rotatedPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page).toHaveURL(/\/overview$/);
}

async function openInstallApp(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: /Install app/ }).click();
}

test.describe('installable app', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'BROWSERHIVE_E2E_URL / BROWSERHIVE_E2E_PASSWORD not set',
  );

  test.describe('persistent context (installability as Chromium reports it)', () => {
    let profile = '';
    let context: BrowserContext;
    test.beforeAll(async () => {
      profile = mkdtempSync(join(tmpdir(), 'bh-pwa-e2e-'));
      // The full Chromium (`channel: 'chromium'`) in a persistent profile: the headless shell
      // reports `[]` for anything and an ordinary context reports `in-incognito`.
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1280, height: 800 },
      });
    });
    test.afterAll(async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    });

    test('the manifest parses without errors and the dashboard is installable', async () => {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`${baseUrl}/login`);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      const cdp = await context.newCDPSession(page);
      await expect
        .poll(
          async () => {
            const manifest = (await cdp.send('Page.getAppManifest')) as {
              readonly url: string;
              readonly errors: readonly unknown[];
            };
            return { url: manifest.url, errors: manifest.errors };
          },
          { timeout: 15_000 },
        )
        .toEqual({ url: `${baseUrl}/manifest.webmanifest`, errors: [] });
      await expect
        .poll(
          async () =>
            (
              (await cdp.send('Page.getInstallabilityErrors')) as {
                readonly installabilityErrors: readonly { readonly errorId: string }[];
              }
            ).installabilityErrors.map((e) => e.errorId),
          { timeout: 15_000 },
        )
        .toEqual([]);
      await cdp.detach();
    });

    test('negative control: a page without a manifest reports no-manifest', async () => {
      const page = await context.newPage();
      // Under a reserved prefix, so the offline worker (registered by the first test) leaves the
      // navigation to the network and this route answers it; an SPA path would get index.html.
      await page.route(`${baseUrl}/api/no-manifest-control`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html lang="en"><title>control</title><h1>No manifest here</h1></html>',
        }),
      );
      await page.goto(`${baseUrl}/api/no-manifest-control`);
      await expect(page.getByRole('heading', { name: 'No manifest here' })).toBeVisible();
      const cdp = await context.newCDPSession(page);
      await expect
        .poll(
          async () =>
            (
              (await cdp.send('Page.getInstallabilityErrors')) as {
                readonly installabilityErrors: readonly { readonly errorId: string }[];
              }
            ).installabilityErrors.map((e) => e.errorId),
          { timeout: 15_000 },
        )
        .toContain('no-manifest');
      await cdp.detach();
      await page.close();
    });

    test('after a click the browser offers the install, and Install app calls prompt()', async () => {
      const page = await context.newPage();
      // Count prompt() calls without changing what they do.
      await page.addInitScript(() => {
        const proto = (window as unknown as { BeforeInstallPromptEvent?: { prototype: object } })
          .BeforeInstallPromptEvent?.prototype as { prompt?: () => Promise<unknown> } | undefined;
        const original = proto?.prompt;
        const counter = window as unknown as { __bhPromptCalls: number; __bhOffers: number };
        counter.__bhPromptCalls = 0;
        counter.__bhOffers = 0;
        addEventListener('beforeinstallprompt', () => {
          counter.__bhOffers += 1;
        });
        if (proto !== undefined && original !== undefined) {
          proto.prompt = function prompt(this: unknown) {
            counter.__bhPromptCalls += 1;
            return original.call(this);
          };
        }
      });
      await signIn(page);
      // Chromium offers the install only after the user interacted with the page.
      await page.getByRole('heading', { level: 1, name: 'Overview' }).click();
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __bhOffers: number }).__bhOffers), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      await openInstallApp(page);
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { __bhPromptCalls: number }).__bhPromptCalls),
        )
        .toBe(1);
      // The browser's own dialog, not ours.
      await expect(page.getByRole('dialog', { name: 'Install BrowserHive' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.close();
    });
  });

  test.describe('ordinary context', () => {
    test.use({ bypassCSP: true });

    test('the offline worker activates and controls the dashboard', async ({ page }) => {
      await signIn(page);
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const registration = await navigator.serviceWorker.getRegistration('/');
              return {
                active: registration?.active?.state ?? null,
                script: registration?.active?.scriptURL.replace(location.origin, '') ?? null,
                controlled: navigator.serviceWorker.controller !== null,
              };
            }),
          { timeout: 20_000 },
        )
        .toEqual({ active: 'activated', script: '/sw.js', controlled: true });
    });

    test('with no install prompt, Install app opens the instructions dialog, which passes axe', async ({
      page,
    }) => {
      await signIn(page);
      await openInstallApp(page);
      const dialog = page.getByRole('dialog', { name: 'Install BrowserHive' });
      await expect(dialog).toBeVisible();
      // Playwright's Chromium reports the Chromium brand, not Google Chrome: the generic steps.
      await expect(dialog).toContainText('Click the install icon in the address bar');
      await expect(dialog.getByRole('link', { name: /Learn more/ })).toHaveAttribute(
        'href',
        /guide\/dashboard\/#install-as-an-app$/,
      );
      await page.addScriptTag({ path: AXE_PATH });
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: {
              run: (
                context: Element,
                options: object,
              ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
            };
          }
        ).axe;
        const root = document.querySelector('[role="dialog"]');
        if (root === null) return ['no dialog'];
        const result = await axe.run(root, { resultTypes: ['violations'] });
        return result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
        );
      });
      expect(violations).toEqual([]);
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
    });
  });
});
