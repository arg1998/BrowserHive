/** @module app/site-packs/tool-gate — site pack enforcement on the tool path of an agent's template session (spec 13 §9.3, §9.5), before the browser is touched: a stopped site, the `GET` document guards of `navigate`/`new_tab`, and element guards of the interaction tools. An early, friendlier refusal; the host's request guard is the boundary. */

import type { PackElementGuard, PackGuardKind } from '@browserhive/contracts/site-packs';
import type { Page } from 'patchright';
import type { Session } from '../../domain/session/session.ts';
import { hostOf, templateSiteOf } from '../../domain/site-packs/site-of-url.ts';
import {
  effectiveAction,
  effectiveWritePolicy,
  elementGuardsFor,
} from '../../domain/site-packs/tool-guards.ts';
import { type AppError, assertNever } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain, sanitizeUrl } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import {
  type SecurityIntercepts,
  SITE_HOLD_EXEMPT_TOOLS,
} from '../../ports/security-intercepts.ts';

export { SITE_HOLD_EXEMPT_TOOLS } from '../../ports/security-intercepts.ts';

import type { WritePolicyOverrides } from '../../ports/site-guards.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';
import type { DocumentGuardResolver } from '../../ports/site-tool-guards.ts';
import type { AgentNavigations } from './agent-navigations.ts';
import {
  ELEMENT_GUARD_TOOLS,
  elementTargets,
  guardLocator,
  insideGuard,
} from './element-targets.ts';
import { siteActionBlocked, siteOperatorPending, urlBlockedByGuard } from './site-errors.ts';
import type { ToolGuardHits } from './tool-guard-hits.ts';

/** Tools that load an agent-given URL (`GET` document guards and the own-navigation record). */
const NAVIGATION_TOOLS: ReadonlySet<string> = new Set(['navigate', 'new_tab']);

/** How long one element guard query may take before the check is skipped (fail-open). */
export const ELEMENT_QUERY_MS = 3_000;

/** One tool call on a session. */
export interface SiteToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly session: Session;
}

/** Collaborators of {@link SiteToolGate}. */
export interface SiteToolGateDeps {
  /** The template's sites (`template_sites`). */
  readonly sites: (templateId: string) => Promise<readonly TemplateSiteRecord[]>;
  /** The registry's read side; `null` until wired or under `sitePacks=false`. */
  readonly lookup: () => SitePackLookup | null;
  /** `null` when no operator can answer (stdio) or until wired: `confirm` acts as `block`. */
  readonly intercepts: () => SecurityIntercepts | null;
  /**
   * The `GET` document guard of a navigation: the host's own rule source (WP-E1: the owning pack's
   * guards with the write policy resolved, then `DEFAULT_GUARDS`); `null` until wired.
   */
  readonly documentGuard: () => DocumentGuardResolver | null;
  /** The template sites' write-policy overrides (WP-E1's `TemplateWritePolicies`); `null` until wired. */
  readonly overrides: () => WritePolicyOverrides | null;
  readonly hits: ToolGuardHits;
  readonly navigations: AgentNavigations;
  /** The tab's page (`SessionService.page`). @throws `TAB_NOT_FOUND` */
  readonly pageOf: (session: Session, tabId?: string) => Page;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** What decided: a pack (or built-in) guard, with the facts its hit row and refusal need. */
interface Decision {
  readonly packId: string;
  readonly guardId: string;
  readonly kind: PackGuardKind;
  readonly action: 'block' | 'confirm' | 'warn' | 'allow';
  readonly source: 'tool' | 'element';
  readonly method: string | null;
  readonly url: string;
}

/** The tool-path gate. */
export class SiteToolGate {
  readonly #deps: SiteToolGateDeps;
  readonly #log: Logger;

  constructor(deps: SiteToolGateDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.tool-gate' });
  }

  /**
   * Runs before the handler of a tool on an agent's template session.
   *
   * @throws `SITE_OPERATOR_PENDING` (`stopped`, `write_confirm`), `URL_BLOCKED`
   *   (`<pack id>#<guard id>`), `SITE_ACTION_BLOCKED`
   */
  async beforeTool(call: SiteToolCall): Promise<void> {
    const { session, tool } = call;
    const template = session.template;
    if (template === null || template.mode !== 'live' || SITE_HOLD_EXEMPT_TOOLS.has(tool)) return;
    const sites = await this.#deps.sites(template.templateId);
    const lookup = this.#deps.lookup();
    const packIdOf = (host: string) => lookup?.effectiveFor(host)?.packId ?? null;
    const target = NAVIGATION_TOOLS.has(tool) ? hrefOf(call.args['url']) : null;
    const page = tool === 'new_tab' ? null : this.#page(session, call.args['tab_id']);
    const pageUrl = page === null ? null : safeUrl(page);
    for (const url of [target, pageUrl]) {
      if (url === null) continue;
      const site = templateSiteOf(sites, url, packIdOf);
      if (site?.stoppedAt != null) this.#stopped(call, site, url);
    }
    if (target !== null) {
      await this.#navigation(call, target, sites, lookup);
      if (tool === 'navigate' && page !== null) this.#deps.navigations.expectOnPage(page, target);
      else this.#deps.navigations.expectNewTab(session.id, target);
    }
    if (page !== null && pageUrl !== null && lookup !== null && ELEMENT_GUARD_TOOLS.has(tool)) {
      await this.#elements(call, page, pageUrl, sites, lookup);
    }
  }

  #page(session: Session, tabId: unknown): Page | null {
    try {
      return this.#deps.pageOf(session, typeof tabId === 'string' ? tabId : undefined);
    } catch {
      // The handler raises `TAB_NOT_FOUND` itself.
      return null;
    }
  }

  #stopped(call: SiteToolCall, site: TemplateSiteRecord, url: string): never {
    const template = call.session.template;
    this.#deps.hits.record({
      sessionId: call.session.id,
      templateId: template?.templateId ?? '',
      packId: site.packId ?? site.siteId,
      guardId: 'stop',
      guardKind: 'stop',
      action: 'block',
      source: 'tool',
      method: NAVIGATION_TOOLS.has(call.tool) ? 'GET' : null,
      url,
      tool: call.tool,
    });
    throw siteOperatorPending(call.session.id, site.siteId, null, 'stopped');
  }

  async #navigation(
    call: SiteToolCall,
    url: string,
    sites: readonly TemplateSiteRecord[],
    lookup: SitePackLookup | null,
  ): Promise<void> {
    const host = hostOf(url);
    const templateId = call.session.template?.templateId;
    if (host === null || templateId === undefined) return;
    const effective = lookup?.effectiveFor(host) ?? null;
    const hit = this.#deps.documentGuard()?.(templateId, url) ?? null;
    if (hit === null) return;
    const decision: Decision = {
      packId: hit.packId,
      guardId: hit.guardId,
      kind: hit.kind,
      action: hit.action,
      source: 'tool',
      method: 'GET',
      url,
    };
    await this.#decide(call, decision, siteOf(sites, url, effective), () =>
      urlBlockedByGuard(url, hit.ruleId),
    );
  }

  async #elements(
    call: SiteToolCall,
    page: Page,
    pageUrl: string,
    sites: readonly TemplateSiteRecord[],
    lookup: SitePackLookup,
  ): Promise<void> {
    const host = hostOf(pageUrl);
    const effective = host === null ? null : lookup.effectiveFor(host);
    if (effective === null) return;
    const guards = elementGuardsFor(effective.pack, pageUrl);
    if (guards.length === 0) return;
    const targets = elementTargets(page, call.tool, call.args);
    if (targets.length === 0) return;
    const guard = await this.#firstGuarded(page, guards, targets);
    if (guard === null) return;
    const override = this.#deps.overrides()?.overrideFor(call.session.template?.templateId ?? '', {
      id: effective.packId,
      domains: effective.pack.domains,
    });
    const policy = effectiveWritePolicy(effective.pack, override ?? null);
    const ruleId = `${effective.packId}#${guard.id}`;
    const site = siteOf(sites, pageUrl, effective);
    const decision: Decision = {
      packId: effective.packId,
      guardId: guard.id,
      kind: guard.kind,
      action: effectiveAction(guard.action, policy),
      source: 'element',
      method: null,
      url: pageUrl,
    };
    await this.#decide(call, decision, site, () =>
      siteActionBlocked(call.session.id, site, ruleId),
    );
  }

  /** The first guard (pack order) whose control is, or holds, one of `targets`; fail-open. */
  async #firstGuarded(
    page: Page,
    guards: readonly PackElementGuard[],
    targets: readonly ReturnType<Page['locator']>[],
  ): Promise<PackElementGuard | null> {
    for (const guard of guards) {
      const locator = guardLocator(page, guard);
      for (const target of targets) {
        try {
          if (await withTimeout(this.#deps.clock, insideGuard(locator, target), ELEMENT_QUERY_MS))
            return guard;
        } catch (err) {
          this.#log.debug('element guard skipped', {
            guard: guard.id,
            err: serializeError(err),
          });
        }
      }
    }
    return null;
  }

  /** Acts on a decision (spec 13 §9.3 the tool path) and records its hit row. */
  async #decide(
    call: SiteToolCall,
    d: Decision,
    site: string,
    blocked: () => AppError,
  ): Promise<void> {
    const sessionId = call.session.id;
    const templateId = call.session.template?.templateId ?? '';
    const hit = {
      sessionId,
      templateId,
      packId: d.packId,
      guardId: d.guardId,
      guardKind: d.kind,
      source: d.source,
      method: d.method,
      url: d.url,
      tool: call.tool,
    };
    switch (d.action) {
      case 'allow':
        return;
      case 'warn':
        this.#deps.hits.record({ ...hit, action: 'warn' });
        return;
      case 'block':
        this.#deps.hits.record({ ...hit, action: 'block' });
        throw blocked();
      case 'confirm': {
        const intercepts = this.#deps.intercepts();
        const result =
          intercepts === null
            ? ({ kind: 'blocked', reason: 'no_operator' } as const)
            : await intercepts.requestWriteApproval({
                sessionId,
                templateId,
                site,
                packId: d.packId,
                guardId: d.guardId,
                guardKind: d.kind,
                method: d.method,
                url: sanitizeUrl(d.url),
                tool: call.tool,
                source: d.source === 'element' ? 'element' : 'request',
                ...targetOf(call.args),
              });
        // A pass and a pending confirmation are recorded by the security intercepts (the row of
        // the settled confirmation); only a refusal acting as `block` is this path's row.
        if (result.kind === 'pass') return;
        if (result.kind === 'pending') {
          throw siteOperatorPending(sessionId, site, result.requestId, 'write_confirm');
        }
        this.#deps.hits.record({ ...hit, action: 'block' });
        throw blocked();
      }
      default:
        return assertNever(d.action);
    }
  }
}

/** The site a refusal names: the template's site of the URL, else its registrable domain. */
function siteOf(
  sites: readonly TemplateSiteRecord[],
  url: string,
  effective: EffectivePack | null,
): string {
  const site = templateSiteOf(sites, url, () => effective?.packId ?? null);
  if (site !== null) return site.siteId;
  const host = hostOf(url);
  return host === null ? url : registrableDomain(host) || host;
}

function hrefOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value.trim()).href;
  } catch {
    return null;
  }
}

function safeUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

/** `work`, or a rejection after `ms` on `clock` (the query is left to finish on its own). */
async function withTimeout<T>(clock: Clock, work: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timeout = clock.sleep(ms, controller.signal).then(
    () => Promise.reject(new Error('element guard query timed out')),
    () => new Promise<never>(() => undefined),
  );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    controller.abort();
  }
}

/** The control the agent named (`selector`, else `source`/`target` of a drag), keying the one-time pass. */
function targetOf(args: Readonly<Record<string, unknown>>): { target?: string } {
  for (const key of ['selector', 'source', 'target']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return { target: `${key}:${value}` };
  }
  return {};
}
