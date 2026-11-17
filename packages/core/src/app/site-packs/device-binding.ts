/** @module app/site-packs/device-binding — `device-bound-session` (spec 13 §9.4): a response of a template host whose URL belongs to an approved pack selecting the strategy and that carries `Sec-Session-Registration` or `Sec-Session-Id` (Device Bound Session Credentials) marks the template site of that URL `device_bound` once, and the template's views are refreshed. Observation only: no request is ever changed, and a failure is logged (fail-open). A deleted template's pairs are forgotten (`template.removed`). */

import { hostOf, templateSiteOf } from '../../domain/site-packs/site-of-url.ts';
import { strategyOf } from '../../domain/site-packs/strategy-params.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { UnitOfWork } from '../../ports/persistence/index.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { HostResponse } from '../../ports/template-host.ts';
import type { DomainEvents } from '../events/catalog.ts';

/** The DBSC response headers (lower-cased, as Chromium reports them). */
export const DBSC_HEADERS = ['sec-session-registration', 'sec-session-id'] as const;

/** Collaborators of {@link DeviceBindingWatch}. */
export interface DeviceBindingWatchDeps {
  readonly lookup: () => SitePackLookup | null;
  /** A `BEGIN IMMEDIATE` transaction: the site is read and written without a lost update. */
  readonly uow: UnitOfWork;
  /** `template.changed` (the Sites tab's badge). */
  readonly changed: (templateId: string) => void;
  /** `template.removed`: a deleted template's pairs are forgotten. */
  readonly bus: Pick<EventBus<DomainEvents>, 'subscribe'>;
  readonly logger: Logger;
}

/** Watches template hosts' responses for device-bound sessions. */
export class DeviceBindingWatch {
  readonly #deps: DeviceBindingWatchDeps;
  readonly #log: Logger;
  /** `(template, pack)` pairs already handled in this process: one write each. */
  readonly #seen = new Set<string>();
  readonly #off: () => void;

  constructor(deps: DeviceBindingWatchDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.device-binding' });
    this.#off = deps.bus.subscribe('template.removed', ({ payload }) => {
      const prefix = `${payload.template_id}\u0000`;
      for (const key of [...this.#seen]) if (key.startsWith(prefix)) this.#seen.delete(key);
    });
  }

  /** Unsubscribes from the bus. */
  stop(): void {
    this.#off();
  }

  /** One response of a template host (the host's `responseReceived`). Never throws. */
  responseReceived(templateId: string, response: HostResponse): void {
    try {
      const host = hostOf(response.url);
      if (host === null) return;
      const pack = this.#deps.lookup()?.effectiveFor(host) ?? null;
      if (pack === null || strategyOf(pack.pack, 'device-bound-session') === null) return;
      const key = `${templateId}\u0000${pack.packId}`;
      if (this.#seen.has(key)) return;
      const headers = response.headers();
      if (!DBSC_HEADERS.some((name) => headers[name] !== undefined)) return;
      this.#seen.add(key);
      void this.#mark(templateId, response.url, pack.packId).catch((err: unknown) => {
        this.#seen.delete(key);
        this.#log.warn('device binding not saved', { templateId, err: serializeError(err) });
      });
    } catch (err) {
      this.#log.debug('device binding skipped', { err: serializeError(err) });
    }
  }

  async #mark(templateId: string, url: string, packId: string): Promise<void> {
    const site = await this.#deps.uow.transaction(async (repos) => {
      const sites = await repos.templateSites.list(templateId);
      const owner = templateSiteOf(sites, url, () => packId);
      if (owner === null || owner.deviceBound) return null;
      await repos.templateSites.upsert({ ...owner, deviceBound: true });
      return owner.siteId;
    });
    if (site === null) return;
    this.#log.info('site is device-bound', { templateId, site, packId });
    this.#deps.changed(templateId);
  }
}
