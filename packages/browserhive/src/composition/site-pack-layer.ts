/** @module composition/site-pack-layer — assembles the site-pack layer for `build-domain` (spec 13 §9, T3a): the registry and the page enforcement before the templates (the prober goes into the health wiring), then the network enforcement once the templates' health exists. */

import type {
  ProberSelector,
  SitePackRegistry,
  TemplateHostSupervisor,
} from '@browserhive/core/server';
import { selectGenericProber } from '@browserhive/core/server';
import type { SitePackEnforcement, SitePackEnforcementInput } from './site-pack-enforcement.ts';
import { buildSitePackEnforcement } from './site-pack-enforcement.ts';
import {
  buildSiteStrategies,
  joinPageWatchers,
  type SiteStrategies,
} from './site-pack-strategies.ts';
import { buildSitePacks, type SitePacksInput } from './site-packs.ts';
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
}

/** Builds the registry and the page enforcement; `undo` receives their stops. */
export async function buildSitePackLayer(
  input: SitePacksInput &
    Omit<SitePackPagesInput, 'repos'> & { readonly undo: (() => void | Promise<void>)[] },
): Promise<SitePackLayer> {
  const registry = await buildSitePacks(input);
  const pages = buildSitePackPages({ ...input, repos: input.repos });
  input.undo.push(pages.stop);
  // `sitePacks=false` (or `templates=false`) turns the whole layer off (spec 13 §9.6).
  const on = input.config.templates && input.config.sitePacks;
  const strategies = buildSiteStrategies({ ...input, registry });
  if (strategies !== null) input.undo.push(strategies.stop);
  return {
    registry,
    pages,
    ...(on && { probers: (supervisor) => pages.probers(supervisor, selectGenericProber) }),
    ...(strategies !== null && { strategies }),
  };
}

/**
 * The network enforcement (the request guard on every template host, security intercepts) and
 * its attachment to the page enforcement; `null` when packs are off.
 */
export function attachSitePackEnforcement(
  layer: SitePackLayer,
  input: Omit<SitePackEnforcementInput, 'lookup'> & {
    readonly undo: (() => void | Promise<void>)[];
  },
): SitePackEnforcement | null {
  const enforcement = buildSitePackEnforcement({ ...input, lookup: layer.registry });
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
