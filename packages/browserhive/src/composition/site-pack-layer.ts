/** @module composition/site-pack-layer — assembles the site-pack layer for `build-domain` (spec 13 §9, T3a): the registry and the page enforcement before the templates (the prober goes into the health wiring), then the network enforcement once the templates' health exists. */

import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import { serializeError } from '@browserhive/core/runtime';
import type {
  ProberSelector,
  SitePackRegistry,
  SitePackRegistryClient,
  TemplateHostSupervisor,
} from '@browserhive/core/server';
import { PINNED_TRUST_ROOT, StrategyState, selectGenericProber } from '@browserhive/core/server';
import { buildSitePackClient, type SitePackClientTesting } from './site-pack-client.ts';
import type { SitePackEnforcement, SitePackEnforcementInput } from './site-pack-enforcement.ts';
import { buildSitePackEnforcement } from './site-pack-enforcement.ts';
import {
  buildSiteStrategies,
  joinPageWatchers,
  type SiteStrategies,
} from './site-pack-strategies.ts';
import { buildSitePacks, resolveBundledPacksDir, type SitePacksInput } from './site-packs.ts';
import {
  buildSitePackPages,
  type SitePackPagesInput,
  type SitePackPagesParts,
} from './site-packs-pages.ts';

/** The layer before the templates exist. */
export interface SitePackLayer {
  readonly registry: SitePackRegistry;
  readonly pages: SitePackPagesParts;
  /** The prober selector for the template health wiring; absent when packs are off. */
  readonly probers?: (supervisor: TemplateHostSupervisor) => ProberSelector;
  /** The host strategies (`webrtc-policy`, `keep-alive`, `device-bound-session`); absent when off. */
  readonly strategies?: SiteStrategies;
  /** The registry root keys signed layouts are verified against (spec 13 §10.2). */
  readonly trustRoot: SitePacksTrustRoot;
  /** The registry client (T4b); `null` when it could not start (a degradation says why). */
  readonly client: SitePackRegistryClient | null;
}

/** The registry root keys: the testing seam's (spec 13 §10.2), else the ones pinned in this binary. */
export function layerTrustRoot(input: Pick<SitePacksInput, 'trustRoot'>): SitePacksTrustRoot {
  return input.trustRoot ?? PINNED_TRUST_ROOT;
}

/** Builds the registry and the page enforcement; `undo` receives their stops. */
export async function buildSitePackLayer(
  input: SitePacksInput &
    Omit<SitePackPagesInput, 'repos'> & {
      readonly undo: (() => void | Promise<void>)[];
      /** One-shot unref'd timer (the automatic update check). */
      readonly schedule: (fn: () => void, ms: number) => () => void;
      /** The testing seam's registry URL and timing (spec 13 §10.2). */
      readonly sitePacksTesting?: SitePackClientTesting | undefined;
    },
): Promise<SitePackLayer> {
  const registry = await buildSitePacks(input);
  const pages = buildSitePackPages({ ...input, repos: input.repos });
  input.undo.push(pages.stop);
  // `sitePacks=false` (or `templates=false`) turns the whole layer off (spec 13 §9.6).
  const on = input.config.templates && input.config.sitePacks;
  // Read back before any strategy decides: a restart keeps budgets and spacings (D53).
  const state = on ? await restoreStrategyState(input) : null;
  const strategies = buildSiteStrategies({ ...input, registry, state });
  if (strategies !== null) input.undo.push(strategies.stop);
  if (state !== null) input.undo.push(() => state.stop());
  const client = await startClient(input, registry);
  return {
    registry,
    pages,
    client,
    trustRoot: layerTrustRoot(input),
    ...(on && { probers: (supervisor) => pages.probers(supervisor, selectGenericProber) }),
    ...(strategies !== null && { strategies }),
  };
}

/** Starts the registry client; a failure never stops the server (logged, the client is absent). */
async function startClient(
  input: Parameters<typeof buildSitePackLayer>[0],
  registry: SitePackRegistry,
): Promise<SitePackRegistryClient | null> {
  try {
    const client = await buildSitePackClient({
      config: input.config,
      registry,
      release: input.release,
      trustRoot: layerTrustRoot(input),
      repos: input.repos,
      clock: input.clock,
      ids: input.ids,
      logger: input.logger,
      bus: input.bus,
      ...(input.degradations !== undefined && { degradations: input.degradations }),
      bundledDir: input.bundledDir ?? resolveBundledPacksDir(),
      schedule: input.schedule,
      testing: input.sitePacksTesting,
    });
    input.undo.push(() => client.stop());
    return client;
  } catch (err) {
    input.logger.warn('registry client failed', { err: serializeError(err) });
    return null;
  }
}

/** The persisted strategy state, read back (never throws: an unreadable table starts empty). */
async function restoreStrategyState(input: SitePacksInput): Promise<StrategyState> {
  const state = new StrategyState({
    repo: input.repos.strategyState,
    clock: input.clock,
    logger: input.logger,
    bus: input.bus,
  });
  await state.restore();
  return state;
}

/**
 * The network enforcement (the request guard on every template host, security intercepts) and
 * its attachment to the page enforcement; `null` when packs are off.
 */
export function attachSitePackEnforcement(
  layer: SitePackLayer,
  input: Omit<SitePackEnforcementInput, 'lookup' | 'state'> & {
    readonly undo: (() => void | Promise<void>)[];
  },
): SitePackEnforcement | null {
  const enforcement = buildSitePackEnforcement({
    ...input,
    lookup: layer.registry,
    state: layer.strategies?.state ?? null,
  });
  if (enforcement === null) return null;
  input.undo.push(enforcement.stop);
  layer.pages.attach({
    enforcement,
    lookup: layer.registry,
    health: input.health?.health ?? null,
  });
  input.driver.attachTemplatePageWatcher(
    joinPageWatchers(input.logger, layer.pages.pageWatcher, layer.strategies?.pageWatcher),
  );
  return enforcement;
}
