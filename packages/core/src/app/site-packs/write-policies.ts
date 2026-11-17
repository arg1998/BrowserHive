/** @module app/site-packs/write-policies — the template sites' write-policy overrides the request guard reads on every request (spec 13 §9.3 `write_policy`): loaded when a template's host starts, refreshed on every `template.changed`, dropped on `template.removed`. */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { SiteWritePolicy } from '../../ports/persistence/enums.ts';
import type { TemplateSiteRecord, TemplateSiteRepository } from '../../ports/persistence/index.ts';
import type { WritePolicyOverrides } from '../../ports/site-guards.ts';
import type { DomainEvents } from '../events/catalog.ts';

type SiteFacts = Pick<TemplateSiteRecord, 'siteId' | 'packId' | 'writePolicy' | 'enabled'>;

/** The overrides of every loaded template, read synchronously. */
export class TemplateWritePolicies implements WritePolicyOverrides {
  readonly #sites: Pick<TemplateSiteRepository, 'list'>;
  readonly #log: Logger;
  readonly #byTemplate = new Map<string, readonly SiteFacts[]>();
  readonly #off: (() => void)[];

  constructor(deps: {
    readonly sites: Pick<TemplateSiteRepository, 'list'>;
    readonly bus: Pick<EventBus<DomainEvents>, 'subscribe'>;
    readonly logger: Logger;
  }) {
    this.#sites = deps.sites;
    this.#log = deps.logger.child({ module: 'site-packs.policies' });
    this.#off = [
      deps.bus.subscribe('template.changed', ({ payload }) => {
        const id = payload.template.template_id;
        if (this.#byTemplate.has(id)) void this.load(id).catch(() => undefined);
      }),
      deps.bus.subscribe('template.removed', ({ payload }) => {
        this.#byTemplate.delete(payload.template_id);
      }),
    ];
  }

  /**
   * Reads a template's sites (a host start awaits it, so its first request sees the overrides).
   * @throws what the repository throws.
   */
  async load(templateId: string): Promise<void> {
    try {
      const sites = await this.#sites.list(templateId);
      this.#byTemplate.set(
        templateId,
        sites.map((s) => ({
          siteId: s.siteId,
          packId: s.packId,
          writePolicy: s.writePolicy,
          enabled: s.enabled,
        })),
      );
    } catch (error) {
      this.#log.warn('write policies not loaded', { templateId, err: serializeError(error) });
      throw error;
    }
  }

  overrideFor(
    templateId: string,
    pack: { readonly id: string; readonly domains: readonly string[] },
  ): SiteWritePolicy | null {
    const sites = this.#byTemplate.get(templateId);
    if (sites === undefined) return null;
    const own =
      sites.find((s) => s.packId === pack.id) ?? sites.find((s) => pack.domains.includes(s.siteId));
    return own?.writePolicy ?? null;
  }

  /** Unsubscribes from the bus. */
  stop(): void {
    for (const off of this.#off) off();
  }
}
