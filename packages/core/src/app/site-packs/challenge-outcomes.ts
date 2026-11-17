/** @module app/site-packs/challenge-outcomes — what a challenge seen on a host page does (spec 13 §9.5 "Outcome"): on an agent's virtual session an `attention`/`stop` match opens a `security_intercept` (through `SecurityIntercepts`), `stop` also stops the site, every match marks the site `challenged`; maintenance sessions and probes are the prober's (no request); `notify` is health only; under stdio health only. Never throws. */

import {
  BUILTIN_PACK_ID,
  type ChallengeRule,
  challengeReason,
} from '../../domain/site-packs/challenges.ts';
import { hostOf, templateSiteOf } from '../../domain/site-packs/site-of-url.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain, sanitizeUrl } from '../../kernel/url.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateProbeTrigger,
  TemplateRecord,
} from '../../ports/persistence/index.ts';
import type { SecurityIntercepts } from '../../ports/security-intercepts.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { TemplateSiteStops } from './site-stops.ts';

/** The trigger a challenge's health row is recorded with. */
export const CHALLENGE_TRIGGER: TemplateProbeTrigger = 'attention';

/** A challenge one page matched. */
export interface DetectedChallenge {
  readonly templateId: string;
  readonly sessionId: string;
  /** The main frame's URL (raw; sanitized before it is stored or sent). */
  readonly pageUrl: string;
  readonly rule: ChallengeRule;
}

/** Collaborators of {@link ChallengeOutcomes}. */
export interface ChallengeOutcomesDeps {
  /** The session's template mode (`live` agents only; `undefined` when gone). */
  readonly modeOf: (sessionId: string) => 'live' | 'maintenance' | undefined;
  readonly repos: Pick<Repositories, 'templates' | 'templateSites'>;
  /** Records a sign-in state learned outside a probe (`TemplateHealthService.record`); late-bound. */
  readonly health: () => {
    record(
      template: TemplateRecord,
      siteId: string,
      verdict: ProbeVerdict,
      trigger: TemplateProbeTrigger,
    ): Promise<void>;
  } | null;
  readonly stops: Pick<TemplateSiteStops, 'stop'>;
  /** `null` until wired: the session gets health only. */
  readonly intercepts: () => SecurityIntercepts | null;
  readonly lookup: () => SitePackLookup | null;
  /** Under stdio no operator can answer: health only (spec 13 §9.3). */
  readonly transport: 'http' | 'stdio';
  /** The `site_pack.challenge` event (the `browserhive.site_pack.challenges` metric). */
  readonly bus?: EventPublisher<DomainEvents>;
  readonly logger: Logger;
}

/** Acts on detected challenges. */
export class ChallengeOutcomes {
  readonly #deps: ChallengeOutcomesDeps;
  readonly #log: Logger;

  constructor(deps: ChallengeOutcomesDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.challenges' });
  }

  /** Applies the outcome table of spec 13 §9.5 to one detection. Never throws. */
  async handle(detected: DetectedChallenge): Promise<void> {
    try {
      await this.#handle(detected);
    } catch (err) {
      this.#log.warn('challenge outcome failed', {
        templateId: detected.templateId,
        err: serializeError(err),
      });
    }
  }

  async #handle(detected: DetectedChallenge): Promise<void> {
    const { rule, sessionId, templateId } = detected;
    // Maintenance sessions and probes: the prober reads the page itself (probe outcome only).
    if (this.#deps.modeOf(sessionId) !== 'live') return;
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) return;
    const lookup = this.#deps.lookup();
    const sites = await this.#deps.repos.templateSites.list(templateId);
    const site = templateSiteOf(
      sites,
      detected.pageUrl,
      (host) => lookup?.effectiveFor(host)?.packId ?? null,
    );
    const host = hostOf(detected.pageUrl) ?? '';
    const siteId = site?.siteId ?? (registrableDomain(host) || host);
    const pageUrl = sanitizeUrl(detected.pageUrl);
    this.#deps.bus?.publish('site_pack.challenge', {
      type: 'site_pack.challenge',
      template_id: templateId,
      session_id: sessionId,
      site: siteId,
      kind: rule.kind,
      action: rule.action,
    });
    this.#log.info('site challenge seen', {
      templateId,
      sessionId,
      site: siteId,
      challenge: `${rule.packId}#${rule.id}`,
      action: rule.action,
    });
    const action = rule.action;
    if (action !== 'notify' && this.#deps.transport === 'http') {
      const intercepts = this.#deps.intercepts();
      const packId = rule.packId === BUILTIN_PACK_ID ? null : rule.packId;
      const title = (packId === null ? null : lookup?.effectiveById(packId)?.pack.title) ?? siteId;
      await intercepts?.raiseChallenge({
        sessionId,
        templateId,
        site: siteId,
        siteTitle: title,
        packId,
        challenge: { id: rule.id, kind: rule.kind, action },
        pageUrl,
      });
      if (action === 'stop' && site !== null) await this.#deps.stops.stop(templateId, site.siteId);
    }
    if (site === null) return;
    const verdict: ProbeVerdict = {
      outcome: 'challenged',
      reason: challengeReason(rule.kind),
      finalUrl: pageUrl,
    };
    await this.#deps.health()?.record(template, site.siteId, verdict, CHALLENGE_TRIGGER);
  }
}
