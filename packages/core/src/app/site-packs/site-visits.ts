/** @module app/site-packs/site-visits — when an agent session of a template last loaded each site (spec 13 §9.4 `keep-alive`: a keeper visit is skipped when a virtual session loaded the site within the interval): committed main-frame navigations of the host's agent pages, by registrable domain. In memory; maintenance pages (probes, the keeper, sign-in windows) do not count. */

import type { Frame, Page } from 'patchright';
import { hostOf } from '../../domain/site-packs/site-of-url.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';

/** Collaborators of {@link AgentSiteVisits}. */
export interface AgentSiteVisitsDeps {
  /** True for an agent's virtual session (`template.mode === 'live'`). */
  readonly isAgent: (sessionId: string) => boolean;
  readonly clock: Clock;
}

/** The last agent load per template and registrable domain. */
export class AgentSiteVisits {
  readonly #deps: AgentSiteVisitsDeps;
  readonly #byTemplate = new Map<string, Map<string, number>>();

  constructor(deps: AgentSiteVisitsDeps) {
    this.#deps = deps;
  }

  /** A page of a template host was attributed to a session (the host's page watcher). */
  pageAttributed(templateId: string, page: Page, sessionId: string): void {
    if (!this.#deps.isAgent(sessionId)) return;
    this.loaded(templateId, page.url());
    page.on('framenavigated', (frame: Frame) => {
      if (frame.parentFrame() === null) this.loaded(templateId, frame.url());
    });
  }

  /** An agent page of the template committed `url` in its main frame. */
  loaded(templateId: string, url: string): void {
    const host = hostOf(url);
    if (host === null) return;
    const domain = registrableDomain(host) || host;
    let domains = this.#byTemplate.get(templateId);
    if (domains === undefined) {
      domains = new Map();
      this.#byTemplate.set(templateId, domains);
    }
    domains.set(domain, this.#deps.clock.now());
  }

  /** The last agent load of any of `domains` in the template, or `null`. */
  lastLoad(templateId: string, domains: readonly string[]): number | null {
    const loads = this.#byTemplate.get(templateId);
    if (loads === undefined) return null;
    let last: number | null = null;
    for (const domain of domains) {
      const at = loads.get(domain);
      if (at !== undefined && (last === null || at > last)) last = at;
    }
    return last;
  }

  /** The template was deleted. */
  forget(templateId: string): void {
    this.#byTemplate.delete(templateId);
  }
}
