/** @module app/site-packs/webrtc-host-flags — `webrtc-policy` (spec 13 §3.1, §3.2, §9.4): a template host's command line gets `--force-webrtc-ip-handling-policy=<policy>` while any enabled site's approved pack selects it (the strictest wins), from the compiled-in table only. Each start records the switches it got; when the desired set of a running host changes (a pack applied, reverted, enabled or disabled: `site_pack.changed`; a site added, enabled or disabled: `template.changed`), the host restarts through the operator restart's drain (`templateDrainTimeout`, then a new start). */

import {
  hostFlagsOf,
  sameHostFlags,
  strictestWebRtcPolicy,
} from '../../domain/site-packs/host-flags.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRecord, TemplateSiteRepository } from '../../ports/persistence/index.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { templateStrategies } from './strategy-scope.ts';

/** Collaborators of {@link HostFlagsWatch}. */
export interface HostFlagsWatchDeps {
  readonly sites: Pick<TemplateSiteRepository, 'list'>;
  readonly lookup: () => SitePackLookup | null;
  /** The template's host is running (a stopped one gets the new switches at its next start). */
  readonly running: (templateId: string) => boolean;
  /** Drains and restarts the host (`TemplateHostOperations.restartHost`, in the background). */
  readonly restart: (templateId: string) => Promise<void>;
  readonly bus: Pick<EventBus<DomainEvents>, 'subscribe'>;
  readonly logger: Logger;
}

/** The host switches of every template, and the restarts when they change. */
export class HostFlagsWatch {
  readonly #deps: HostFlagsWatchDeps;
  readonly #log: Logger;
  /** The switches each host started with (the last start of each template). */
  readonly #started = new Map<string, readonly string[]>();
  /** Templates whose restart was asked and whose next start has not come yet. */
  readonly #restarting = new Set<string>();
  /** One check at a time per template. */
  readonly #tails = new Map<string, Promise<void>>();
  readonly #off: (() => void)[];

  constructor(deps: HostFlagsWatchDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.host-flags' });
    this.#off = [
      deps.bus.subscribe('site_pack.changed', () => {
        for (const id of [...this.#started.keys()]) void this.check(id);
      }),
      deps.bus.subscribe('template.changed', ({ payload }) => {
        const id = payload.template.template_id;
        if (this.#started.has(id)) void this.check(id);
      }),
      deps.bus.subscribe('template.removed', ({ payload }) => {
        this.#started.delete(payload.template_id);
        this.#restarting.delete(payload.template_id);
      }),
    ];
  }

  /**
   * The switches of a host start (the host spec's `hostFlags`); remembered as what the host runs
   * with. @throws what the sites read throws (the start fails: no host without its policy).
   */
  async hostFlags(template: TemplateRecord): Promise<readonly string[]> {
    const flags = await this.desired(template.templateId);
    this.#started.set(template.templateId, flags);
    this.#restarting.delete(template.templateId);
    return flags;
  }

  /** The switches the template's enabled sites ask for now. */
  async desired(templateId: string): Promise<readonly string[]> {
    const sites = await this.#deps.sites.list(templateId);
    const policies = templateStrategies(sites, this.#deps.lookup(), 'webrtc-policy').map(
      (s) => s.params.policy,
    );
    return hostFlagsOf(strictestWebRtcPolicy(policies));
  }

  /** Restarts the template's running host when its switches changed. Never throws. */
  check(templateId: string): Promise<void> {
    const run = (this.#tails.get(templateId) ?? Promise.resolve()).then(() =>
      this.#check(templateId).catch((err: unknown) =>
        this.#log.warn('host flags check failed', { templateId, err: serializeError(err) }),
      ),
    );
    this.#tails.set(templateId, run);
    void run.then(() => {
      if (this.#tails.get(templateId) === run) this.#tails.delete(templateId);
    });
    return run;
  }

  async #check(templateId: string): Promise<void> {
    const started = this.#started.get(templateId);
    if (started === undefined || this.#restarting.has(templateId)) return;
    if (!this.#deps.running(templateId)) return;
    const desired = await this.desired(templateId);
    if (sameHostFlags(started, desired)) return;
    this.#restarting.add(templateId);
    this.#log.info('host flags changed', { templateId, from: started, to: desired });
    try {
      await this.#deps.restart(templateId);
    } catch (err) {
      this.#restarting.delete(templateId);
      throw err;
    }
  }

  /** Unsubscribes from the bus. */
  stop(): void {
    for (const off of this.#off) off();
  }
}
