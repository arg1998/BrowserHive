/// <reference lib="dom" />
/** @module test/integration/mcp-fixture — the real MCP stack over real Chromium: PlaywrightBrowserDriver + SessionService + dispatcher + McpServer via the in-memory client, plus the fixture server. A missing Chromium FAILS, never skips. */

import { afterEach, beforeEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createPlaywrightPageActions } from '../../src/infra/browsers/page-actions.ts';
import { PlaywrightBrowserDriver } from '../../src/infra/browsers/playwright-browser-driver.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createNanoidIdGenerator } from '../../src/infra/ids/nanoid-id-generator.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import {
  createToolHarness,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../helpers/fake-transport.ts';
import { type FixtureServer, startFixtureServer } from '../helpers/fixture-server.ts';
import { integrationChannel } from '../helpers/integration-channel.ts';
import { HOST } from './driver-fixture.ts';

/** Per-test state populated by {@link useMcpStack}. */
export interface McpStackState {
  harness: ToolHarness;
  fixture: FixtureServer;
}

/** Throws with the install command when Chromium is missing. */
export function assertChromiumInstalled(): void {
  const path = chromium.executablePath();
  if (!existsSync(path)) {
    throw new Error(
      `integration suite cannot run: Chromium is not installed at ${path}. Run 'bunx playwright install chromium'.`,
    );
  }
}

/** Builds a real-Chromium tool harness (system clock, nanoid ids, Playwright page actions). */
export async function createRealHarness(options: ToolHarnessOptions = {}): Promise<ToolHarness> {
  assertChromiumInstalled();
  const clock = createSystemClock();
  return createToolHarness({
    driver: new PlaywrightBrowserDriver({
      logger: createCollectingLogger(),
      clock,
      host: HOST,
      stealthDriver: 'playwright',
    }),
    pageActions: createPlaywrightPageActions({ clock }),
    clock,
    ids: createNanoidIdGenerator({ clock }),
    defaultChannel: integrationChannel(),
    ...options,
  });
}

/** Spins up the fixture server and a real stack before each test; tears both down after. */
export function useMcpStack(options: ToolHarnessOptions = {}): { state: McpStackState } {
  const state = {} as McpStackState;
  beforeEach(async () => {
    state.fixture = startFixtureServer();
    state.harness = await createRealHarness(options);
  });
  afterEach(async () => {
    await state.harness.close();
    state.fixture.stop();
  });
  return { state };
}
