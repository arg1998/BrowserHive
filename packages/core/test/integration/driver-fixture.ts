/// <reference lib="dom" />
/** @module test/integration/driver-fixture — real PlaywrightBrowserDriver + fixture server per test; a missing Chromium FAILS the suite, never skips. */

import { afterEach, beforeEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { chromium } from 'playwright';
import { evaluateMainWorld } from '../../src/infra/browsers/evaluate.ts';
import { resolveIdentity } from '../../src/infra/browsers/identity-resolver.ts';
import { PlaywrightBrowserDriver } from '../../src/infra/browsers/playwright-browser-driver.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import type { LaunchSpec, SessionHandle } from '../../src/ports/browser-driver.ts';
import { type FixtureServer, startFixtureServer } from '../helpers/fixture-server.ts';

/** The injected host facts for the suite: real platform/arch/release, real env (LC_ALL/LANG). */
export const HOST = { platform: platform(), arch: arch(), release: release(), env: process.env };

/** Per-session request shape the fixture accepts. */
export interface SessionRequest {
  readonly slug: string;
  readonly stealth?: boolean;
  readonly fingerprint?: boolean;
  readonly headless?: boolean;
  readonly contextOptions?: LaunchSpec['contextOptions'];
  readonly launchOptions?: LaunchSpec['launchOptions'];
  readonly persistenceMode?: LaunchSpec['persistenceMode'];
  readonly tracing?: boolean;
}

/** A launched session plus the geo the identity phase resolved (for timezone assertions). */
export interface LaunchedSession {
  readonly handle: SessionHandle;
  readonly page: Page;
  readonly geo: { readonly timezoneId: string } | null;
}

/** The per-test state populated by {@link useDriverFixtures}. */
export interface IntegrationState {
  driver: PlaywrightBrowserDriver;
  fixture: FixtureServer;
  dataDir: string;
  sessions: SessionHandle[];
  launch(request: SessionRequest): Promise<LaunchedSession>;
}

/**
 * Evaluate in the MAIN world. The stealth driver (Patchright) isolates `page.evaluate` by default; to
 * read what a page's own scripts see, the driver-aware helper passes `isolatedContext: false` only
 * where the driver accepts it (stock Playwright 1.63 rejects the extra argument).
 */
export function evalMain<T>(session: LaunchedSession, fn: () => T, page?: Page): Promise<T> {
  return evaluateMainWorld(page ?? session.page, session.handle.capabilities.isolatedEvaluate, fn);
}

function assertChromiumPresent(): void {
  const path = chromium.executablePath();
  if (!existsSync(path)) {
    throw new Error(
      `integration suite cannot run: Chromium is not installed at ${path}. Run 'bunx playwright install chromium' (and 'bunx patchright install chromium').`,
    );
  }
}

/** Spins up the driver, a data dir and the fixture server before each test; tears everything down after. */
export function useDriverFixtures(): { state: IntegrationState } {
  const state: IntegrationState = {
    sessions: [],
    launch: async () => {
      throw new Error('fixture not initialised');
    },
  } as unknown as IntegrationState;
  let counter = 0;

  beforeEach(async () => {
    assertChromiumPresent();
    state.sessions = [];
    state.fixture = startFixtureServer();
    state.dataDir = await mkdtemp(join(tmpdir(), 'bh-int-'));
    state.driver = new PlaywrightBrowserDriver({
      logger: createCollectingLogger(),
      clock: createSystemClock(),
      host: HOST,
      stealthDriver: 'auto',
    });
    state.launch = async (request) => {
      const sessionId = `${request.slug}-${(counter++).toString(36).padStart(8, '0')}`;
      const stealth = request.stealth ?? false;
      const fingerprint = stealth && (request.fingerprint ?? false);
      const headless = request.headless ?? true;
      const sessionDir = join(state.dataDir, 'sessions', sessionId);
      const resolved = fingerprint
        ? await resolveIdentity(
            {
              sessionId,
              headless,
              proxy: null,
              ...(request.launchOptions !== undefined && { launchOptions: request.launchOptions }),
              ...(request.contextOptions !== undefined && {
                contextOptions: request.contextOptions,
              }),
            },
            { host: HOST, geoSeed: { resolve: () => Promise.resolve(hostSeed()) } },
          )
        : null;
      const spec: LaunchSpec = {
        sessionId,
        channel: 'chromium',
        incognito: false,
        headless,
        persistenceMode: request.persistenceMode ?? 'memory',
        ...(request.persistenceMode === 'persistent' && {
          userDataDir: join(sessionDir, 'profile'),
        }),
        stealth,
        stealthDriver: 'auto',
        proxy: null,
        downloadsDir: join(sessionDir, 'downloads'),
        ...(request.launchOptions !== undefined && { launchOptions: request.launchOptions }),
        ...(request.contextOptions !== undefined && { contextOptions: request.contextOptions }),
        ...(resolved !== null && { identity: resolved.identity }),
        ...(request.tracing === true && {
          tracing: {
            enabled: true,
            screenshots: true,
            snapshots: true,
            partsDir: join(sessionDir, 'trace-parts'),
          },
        }),
      };
      const handle = await state.driver.launch(spec);
      state.sessions.push(handle);
      return { handle, page: handle.page, geo: resolved?.identity.geo ?? null };
    };
  });

  afterEach(async () => {
    for (const session of state.sessions) await session.close(10_000);
    state.fixture.stop();
    await rm(state.dataDir, { recursive: true, force: true });
  });

  return { state };
}

function hostSeed() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    locale: 'en-CA',
    languages: ['en-CA', 'en'],
    countryCode: 'CA',
    timezoneId: tz.length > 0 ? tz : 'UTC',
    source: 'host' as const,
  };
}
