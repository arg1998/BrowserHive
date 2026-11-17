/// <reference lib="dom" />
/**
 * @module test/helpers/preflight-first-page — run as its own process by `cors-preflights.test.ts`: in
 * a process where no page exists yet, an interception chain installed on a context without pages
 * must still hand that context's first page's preflights to Chromium (the driver's network manager
 * is wrapped when the first page appears, D-66). Prints one JSON line `{armed, page, methods}`.
 *
 * Usage: `bun preflight-first-page.ts <page-url> <refusing-endpoint-url> <channel>`.
 */

import { Blocklist } from '../../src/domain/policies/blocklist.ts';
import { blocklistHandler } from '../../src/infra/browsers/blocklist-route.ts';
import { driverChromium, suppressInjectRoute } from '../../src/infra/browsers/driver.ts';
import { fixedOwner, InterceptionChain } from '../../src/infra/browsers/interception-chain.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';

const [pageUrl, target, channel] = process.argv.slice(2);
if (pageUrl === undefined || target === undefined) throw new Error('usage: <page-url> <target>');

const browser = await driverChromium().launch({
  headless: true,
  ...(channel === 'chrome' && { channel: 'chrome' }),
});
try {
  const context = await browser.newContext();
  suppressInjectRoute(context);
  const clock = createSystemClock();
  const logger = createCollectingLogger();
  const chain = new InterceptionChain({
    handlers: [
      blocklistHandler({
        blocklist: new Blocklist(),
        observer: { blocked: () => undefined },
        sessionId: 'fresh',
        clock,
        logger,
      }),
    ],
    resolveOwner: fixedOwner('fresh'),
    clock,
    logger,
  });
  const pagesBefore = context.pages().length;
  const installed = await chain.install(context);
  const page = await context.newPage();
  await page.goto(pageUrl);
  const result = await page.evaluate(
    (url) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-custom': '1' },
        body: '{}',
      }).then(
        (r) => `ok:${r.status}`,
        (e: Error) => `err:${e.name}`,
      ),
    target,
  );
  process.stdout.write(
    `${JSON.stringify({
      pagesBefore,
      installed: installed.ok,
      armed: chain.preflightsEnforced,
      page: result,
    })}\n`,
  );
} finally {
  await browser.close();
}
