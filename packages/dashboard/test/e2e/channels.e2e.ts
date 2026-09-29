/** @module dashboard/test/e2e/channels.e2e — the notification channels journey against a running daemon: add a webhook channel through the wizard (pointed at a receiver this test starts, answering from the chat switched on), preview it, save, send a real test and see it arrive, find it in the delivery log, the empty Actions audit, delete it; skips cleanly without a daemon */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/** A webhook receiver on 127.0.0.1 that records every request body. */
async function startReceiver(): Promise<{ server: Server; url: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      req.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
      });
      req.on('end', () => resolve(text));
    });
  const server = createServer((req, res) => {
    void read(req).then((text) => {
      try {
        bodies.push(JSON.parse(text));
      } catch {
        bodies.push(text);
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/browserhive`, bodies };
}

test.describe('notification channels', () => {
  test.skip(
    baseUrl === undefined || seedPassword === undefined,
    'BROWSERHIVE_E2E_URL / BROWSERHIVE_E2E_PASSWORD not set',
  );

  test('add a webhook channel with act buttons, preview, save, test, see it in the log, delete', async ({
    page,
  }, testInfo) => {
    const receiver = await startReceiver();
    const name = `e2e-hook-${testInfo.project.name}`.slice(0, 32);
    try {
      await signIn(page);
      await page.goto('/notifications/channels/new');
      await expect(page.getByText('Where should notifications go?')).toBeVisible();

      // 1. Platform
      await page.locator('label').filter({ hasText: 'POSTs the notification' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      // 2. Credentials: the signing secret is optional.
      await expect(page.getByText('Where to get it')).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();
      // 3. Connect: the receiver's URL (a private address is allowed, with a note).
      await page.getByLabel('URL', { exact: true }).fill(receiver.url);
      await expect(page.getByText('A private address')).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();
      // 4. What to send: name it, and let the receiver answer (act buttons travel in the payload).
      await page.getByLabel('Name', { exact: true }).fill(name);
      const answer = page.getByRole('switch', { name: 'Answer from the chat' });
      await expect(answer).not.toBeChecked();
      await answer.click();
      await expect(answer).toBeChecked();
      await expect(page.getByText('Your receiver answers')).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();
      // 5. Preview (drawn by the server's renderer), save, send a real test.
      await expect(page.locator('[data-platform="webhook"]')).toBeVisible();
      await page.getByRole('button', { name: 'Save channel' }).click();
      await expect(page.getByText(`${name} is saved`)).toBeVisible();
      await page.getByRole('button', { name: 'Send test' }).click();
      await expect(page.getByText('Test message sent')).toBeVisible();
      await expect.poll(() => receiver.bodies.length).toBeGreaterThan(0);
      const body = receiver.bodies[0] as { event?: string; message?: { kind?: string } };
      expect(body.event).toBe('notification');
      expect(body.message?.kind).toBe('test');

      // The delivery log shows the sent test.
      await page.goto('/notifications/log');
      await expect(page.getByText(name).first()).toBeVisible();

      // The card says who answers.
      await page.goto('/notifications/channels');
      const card = page.locator('article').filter({ has: page.getByRole('heading', { name }) });
      await expect(card).toBeVisible();
      await expect(card.getByText('Answers from the chat')).toBeVisible();

      // Nothing was pressed: the Actions audit explains itself.
      await page.goto('/notifications/actions');
      await expect(page.getByText('No answers from a chat yet')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to channels' })).toBeVisible();

      // Delete the channel.
      await page.goto('/notifications/channels');
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: `More actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: /Delete/ }).click();
      await page.getByRole('button', { name: 'Delete channel' }).click();
      await expect(page.getByRole('heading', { name })).toHaveCount(0);
    } finally {
      await new Promise<void>((resolve) => receiver.server.close(() => resolve()));
    }
  });

  test('schedule a daily digest in a time zone, send one now, see it in the log', async ({
    page,
  }, testInfo) => {
    const receiver = await startReceiver();
    const name = `e2e-digest-${testInfo.project.name}`.slice(0, 32);
    try {
      await signIn(page);
      await page.goto('/notifications/channels/new');
      await page.locator('label').filter({ hasText: 'POSTs the notification' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByLabel('URL', { exact: true }).fill(receiver.url);
      await page.getByRole('button', { name: 'Continue' }).click();
      // 4. What to send: the Daily digest preset switches the digest and the anomaly alerts on.
      await page.getByLabel('Name', { exact: true }).fill(name);
      await page.locator('label').filter({ hasText: 'A summary every morning' }).click();
      await expect(page.getByRole('button', { name: 'Every day' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByText('Next digest:')).toBeVisible();
      await expect(
        page.getByRole('switch', { name: 'Tell me when something looks off' }),
      ).toBeChecked();
      // A zone of its own: type to search.
      const zone = page.getByLabel(/Time zone/);
      await zone.fill('Tokyo');
      await page.getByRole('option', { name: 'Asia/Tokyo' }).click();
      await expect(page.getByText(/in Asia\/Tokyo/)).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Save channel' }).click();
      await expect(page.getByText(`${name} is saved`)).toBeVisible();

      // The card shows the next digest and sends one on demand.
      await page.goto('/notifications/channels');
      const card = page.locator('article').filter({ has: page.getByRole('heading', { name }) });
      await expect(card.getByText('Daily digest', { exact: true }).last()).toBeVisible();
      await expect(card.getByText(/\(Asia\/Tokyo\)/)).toBeVisible();
      await expect(card.getByText('Watching for anomalies')).toBeVisible();
      await card.getByRole('button', { name: 'Send now' }).click();
      const dialog = page.getByRole('dialog', { name: 'Send a digest now' });
      await expect(dialog.locator('[data-platform="webhook"]')).toBeVisible();
      await dialog.getByRole('button', { name: /Send now/ }).click();
      await expect(dialog.getByText(/Digest sent/)).toBeVisible();
      await expect.poll(() => receiver.bodies.length).toBeGreaterThan(0);
      const body = receiver.bodies.at(-1) as {
        message?: { kind?: string; report?: { manual?: boolean; time_zone?: string } };
      };
      expect(body.message?.kind).toBe('digest.daily');
      expect(body.message?.report).toMatchObject({ manual: true, time_zone: 'Asia/Tokyo' });
      await dialog.getByRole('button', { name: 'Done' }).click();

      // The delivery log marks it as sent on demand.
      await page.goto('/notifications/log');
      await expect(page.getByText('on demand').first()).toBeVisible();

      await page.goto('/notifications/channels');
      await card.getByRole('button', { name: `More actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: /Delete/ }).click();
      await page.getByRole('button', { name: 'Delete channel' }).click();
      await expect(page.getByRole('heading', { name })).toHaveCount(0);
    } finally {
      await new Promise<void>((resolve) => receiver.server.close(() => resolve()));
    }
  });
});
