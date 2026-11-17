/** @module app/site-packs/site-stops — a site's `stop` (spec 13 §9.5): set by a `stop` challenge on an agent's session, cleared by the operator (**Clear stop**, `POST /templates/{id}/sites/{site_id}/clear-stop`, audit `template.site.clear_stop`); each change publishes `template.health`. */

import type { TemplateSiteView } from '@browserhive/contracts/http';
import { registrableDomain } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Repositories, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { notFoundForOperator } from '../templates/template-errors.ts';
import { toSiteView } from '../templates/views.ts';

/** Collaborators of {@link TemplateSiteStops}. */
export interface SiteStopsDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'operatorActions'>;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bus?: EventPublisher<DomainEvents>;
  /** The template's summary changed (`template.changed`). */
  readonly changed?: (templateId: string) => void;
}

/** The stops of template sites. */
export class TemplateSiteStops {
  readonly #deps: SiteStopsDeps;
  readonly #log: Logger;

  constructor(deps: SiteStopsDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.stops' });
  }

  /**
   * Stops a site (a `stop` challenge, spec 13 §9.5): every agent navigation to it and every tool on
   * its pages answers `SITE_OPERATOR_PENDING` (`stopped`) until **Clear stop**. A site already
   * stopped keeps its first time. Returns false when the site does not exist (removed meanwhile).
   */
  async stop(templateId: string, siteId: string): Promise<boolean> {
    const site = await this.#site(templateId, siteId);
    if (site === null) return false;
    if (site.stoppedAt !== null) return true;
    const updated: TemplateSiteRecord = { ...site, stoppedAt: this.#deps.clock.now() };
    await this.#deps.repos.templateSites.upsert(updated);
    this.#log.warn('site stopped', { templateId, site: siteId });
    this.#publish(updated);
    return true;
  }

  /**
   * **Clear stop** (`templates:write`): agents may use the site again. Clearing a site that is not
   * stopped is a no-op that still answers the site.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND` (the template or the site)
   */
  async clear(templateId: string, rawSiteId: string, by: string): Promise<TemplateSiteView> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    const siteId = registrableDomain(rawSiteId) || rawSiteId.toLowerCase();
    const site = await this.#site(templateId, siteId);
    if (site === null) throw notFoundForOperator(templateId);
    if (site.stoppedAt === null) return toSiteView(site);
    const updated: TemplateSiteRecord = { ...site, stoppedAt: null };
    await this.#deps.repos.templateSites.upsert(updated);
    await this.#deps.repos.operatorActions.append({
      eventId: this.#deps.ids.eventId(),
      principalId: by,
      action: 'template.site.clear_stop',
      resourceKind: 'template',
      resourceId: templateId,
      details: { site_id: siteId, stopped_at: site.stoppedAt },
      occurredAt: this.#deps.clock.now(),
    });
    this.#log.info('site stop cleared', { templateId, site: siteId, by });
    this.#publish(updated);
    return toSiteView(updated);
  }

  async #site(templateId: string, siteId: string): Promise<TemplateSiteRecord | null> {
    const sites = await this.#deps.repos.templateSites.list(templateId);
    return sites.find((s) => s.siteId === siteId) ?? null;
  }

  #publish(site: TemplateSiteRecord): void {
    this.#deps.bus?.publish('template.health', {
      type: 'template.health',
      template_id: site.templateId,
      site: toSiteView(site),
    });
    this.#deps.changed?.(site.templateId);
  }
}
