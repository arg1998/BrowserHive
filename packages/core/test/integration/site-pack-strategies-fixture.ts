/** @module test/integration/site-pack-strategies-fixture — the before-action strategies (spec 13 §9.4; T3b WP-B) over the real MCP stack and a real template host: the fixture pack on `site-a.test` selecting the strategies a test names, the tool gate (agents' own navigations) and `SiteActionStrategies` with the real `CdpPageFocus`. */

import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AgentNavigations } from '../../src/app/site-packs/agent-navigations.ts';
import { SiteActionStrategies } from '../../src/app/site-packs/strategies/site-actions.ts';
import { SiteToolGate } from '../../src/app/site-packs/tool-gate.ts';
import { ToolGuardHits } from '../../src/app/site-packs/tool-guard-hits.ts';
import { CdpPageFocus } from '../../src/infra/browsers/focus-emulation.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { ERROR_META_KEY } from '../../src/interface/mcp/shape.ts';
import type { Page } from '../../src/ports/page-types.ts';
import { textOf } from '../helpers/fake-transport.ts';
import { FixtureLookup, fixturePack } from './site-pack-fixture.ts';
import type { StealthLeg } from './template-fixture.ts';
import { type TemplateMcp, templateMcp } from './template-mcp-fixture.ts';

export const SITE = 'site-a.test';

/** One test's world. */
export interface StrategyWorld {
  readonly w: TemplateMcp;
  readonly lookup: FixtureLookup;
  readonly runner: SiteActionStrategies;
  readonly focus: CdpPageFocus;
  /** A new agent session of the template, with a tool caller and its pages. */
  session(slug?: string): Promise<StrategySession>;
  stop(): Promise<void>;
}

/** One agent session. */
export interface StrategySession {
  readonly id: string;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** The session's active page. */
  page(): Page;
}

/** Options of {@link strategyWorld}. */
export interface StrategyWorldOptions {
  readonly stealth?: StealthLeg;
  /** `serialize-site`'s wait (test seam; production 30 s). */
  readonly serializeWaitMs?: number;
  /** `false`: the registry's lookup is `null`, as under `sitePacks=false`. */
  readonly sitePacks?: boolean;
}

/** A world whose `site-a.test` pack selects `strategies`. */
export async function strategyWorld(
  strategies: SitePackV1Input['strategies'],
  options: StrategyWorldOptions = {},
): Promise<StrategyWorld> {
  const clock = createSystemClock();
  const logger = createCollectingLogger();
  const lookup = new FixtureLookup(fixturePack('/pack/probe/in', { strategies }));
  const read = () => (options.sitePacks === false ? null : lookup);
  const navigations = new AgentNavigations(clock);
  const focus = new CdpPageFocus(logger);
  const built: { runner: SiteActionStrategies | null } = { runner: null };
  const w = await templateMcp(options.stealth ?? 'standard', {
    sites: [{ siteId: SITE, packId: SITE, packVersion: 1 }],
    siteGuards: ({ sessions, templates }) =>
      new SiteToolGate({
        sites: (id) => templates.repos.templateSites.list(id),
        lookup: read,
        intercepts: () => null,
        documentGuard: () => null,
        overrides: () => null,
        hits: new ToolGuardHits({ sink: () => null, clock }),
        navigations,
        pageOf: (session, tab) => sessions.page(session, tab),
        clock,
        logger,
      }),
    siteActions: ({ sessions, templates }) => {
      const runner = new SiteActionStrategies({
        lookup: read,
        sites: (id) => templates.repos.templateSites.list(id),
        pageOf: (session, tab) => sessions.page(session, tab),
        pagesOf: (session) => sessions.pages(session),
        sessions: () => sessions.listAll(),
        focus,
        navigations,
        clock,
        random: () => 0.5,
        logger,
        ...(options.serializeWaitMs !== undefined && {
          serializeWaitMs: options.serializeWaitMs,
        }),
      });
      built.runner = runner;
      return runner;
    },
  });
  const runner = built.runner;
  if (runner === null) throw new Error('strategies not built');
  return {
    w,
    lookup,
    runner,
    focus,
    async session(slug = 'strategies') {
      const { session_id: id } = await w.harness.callJson<{ session_id: string }>(
        'launch_session',
        { slug: `agent-${slug}`, template: w.template.name },
      );
      return {
        id,
        call: (name, args = {}) => w.harness.call(name, { session_id: id, ...args }),
        page: () => {
          const s = w.harness.services.sessions.peek(id);
          if (s === undefined) throw new Error('no session');
          return s.tabs.resolve();
        },
      };
    },
    stop: () => w.stop(),
  };
}

/** The result, or a thrown error naming the refusal. */
export function ok(result: CallToolResult): CallToolResult {
  if (result.isError === true) throw new Error(textOf(result));
  return result;
}

/** The error code and details of a refused call. */
export function refusal(result: CallToolResult): {
  code: string;
  details: Record<string, unknown>;
} {
  const meta = (result._meta?.[ERROR_META_KEY] ?? {}) as {
    code?: string;
    details?: Record<string, unknown>;
  };
  return { code: meta.code ?? textOf(result), details: meta.details ?? {} };
}

/** `document.hasFocus()` of a page (read in the driver's isolated world). */
export function hasFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => document.hasFocus());
}
