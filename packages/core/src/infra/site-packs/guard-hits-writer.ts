/** @module infra/site-packs/guard-hits-writer — every guard decision becomes one `site_guard_hits` row (spec 13 §9.3, §9.9): published as `site_pack.guard_hit` (the recorder writes the row through the write queue; the metric `browserhive.site_pack.guard_hits` counts the event); a `warn` hit of a session records `SITE_GUARD_WARNED` on it and a `paced` one `SITE_PACED` (§9.4). */

import type { SiteGuardHitRow } from '@browserhive/contracts/http';
import { type SessionWarning, sessionWarning } from '../../domain/session/warnings.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { RequestGuardHit, RequestGuardHits } from '../../ports/request-guard.ts';
import type {
  GuardRuleDescriber,
  SiteGuardEvents,
  SiteGuardHitInput,
  SiteGuardHitSink,
} from '../../ports/site-guards.ts';
import { HitThrottle } from './hit-throttle.ts';

/** Collaborators of {@link SiteGuardHitsWriter}. */
export interface SiteGuardHitsWriterDeps {
  readonly describe: GuardRuleDescriber;
  readonly bus: EventPublisher<Pick<SiteGuardEvents, 'site_pack.guard_hit'>>;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  /** Records a session warning (`SessionService.warn` on a live session); never throws. */
  readonly warn: (sessionId: string, warning: SessionWarning) => void;
  readonly logger: Logger;
}

/** The guard-hit sink of every template host and of the tool layer. Never throws. */
export class SiteGuardHitsWriter implements SiteGuardHitSink {
  readonly #deps: SiteGuardHitsWriterDeps;
  readonly #log: Logger;
  readonly #throttle = new HitThrottle();

  constructor(deps: SiteGuardHitsWriterDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.hits' });
  }

  /** The network guard's sink for one template host. */
  forTemplate(templateId: string): RequestGuardHits {
    return { record: (hit) => this.#fromRequest(templateId, hit) };
  }

  /** Writes one row (the tool layer's element and navigation guards use it directly). */
  write(input: SiteGuardHitInput): void {
    try {
      const row: SiteGuardHitRow = {
        event_id: this.#deps.ids.eventId(),
        session_id: input.sessionId,
        template_id: input.templateId,
        pack_id: input.packId,
        guard_id: input.guardId,
        guard_kind: input.guardKind,
        action: input.action,
        outcome: input.outcome,
        decided_by: input.decidedBy,
        source: input.source,
        method: input.method,
        url: input.url,
        request_id: input.requestId,
        tool: input.tool,
        ts: input.ts,
      };
      this.#deps.bus.publish('site_pack.guard_hit', { type: 'site_pack.guard_hit', row });
      if (input.action === 'warn' && input.sessionId !== null) {
        this.#deps.warn(input.sessionId, guardWarned(input.sessionId, input));
      }
      if (input.action === 'paced' && input.sessionId !== null) {
        this.#deps.warn(input.sessionId, sitePaced(input.sessionId, input));
      }
    } catch (error) {
      this.#log.warn('guard hit not written', {
        packId: input.packId,
        guardId: input.guardId,
        err: serializeError(error),
      });
    }
  }

  #fromRequest(templateId: string, hit: RequestGuardHit): void {
    // A page looping the same blocked or warned request writes one row per second (L3); a confirmation's
    // decision is always written.
    if (hit.action !== 'confirm') {
      const key = [
        hit.sessionId ?? '',
        hit.ruleId,
        hit.method,
        hit.resourceType,
        hit.url,
        hit.action,
      ].join('\u0000');
      const admitted = this.#throttle.admit(key, hit.ts, (dropped) =>
        this.#log.info('guard hits coalesced', { ruleId: hit.ruleId, url: hit.url, dropped }),
      );
      if (!admitted) return;
    }
    const info = this.#deps.describe(hit.ruleId);
    const [packPart, guardPart] = splitRuleId(hit.ruleId);
    this.write({
      sessionId: hit.sessionId,
      templateId,
      packId: info?.packId ?? packPart,
      guardId: info?.guardId ?? guardPart,
      // A rule id no source produced cannot happen with the pack source; recorded as a write.
      guardKind: info?.guardKind ?? 'write',
      action: hit.action,
      outcome: hit.outcome,
      decidedBy: hit.decidedBy,
      source: 'request',
      method: hit.method,
      url: hit.url,
      requestId: hit.requestId,
      tool: null,
      ts: hit.ts,
    });
  }
}

/** `<pack id>#<guard id>` → its two parts (`browserhive`, the id itself without a `#`). */
function splitRuleId(ruleId: string): [string, string] {
  const at = ruleId.lastIndexOf('#');
  return at < 0 ? ['browserhive', ruleId] : [ruleId.slice(0, at), ruleId.slice(at + 1)];
}

/** The `SITE_GUARD_WARNED` warning (shown to operators). */
export function guardWarned(sessionId: string, hit: SiteGuardHitInput): SessionWarning {
  const method = hit.method === null ? '' : `${hit.method} `;
  return sessionWarning(
    'SITE_GUARD_WARNED',
    sessionId,
    `A guarded request went out: ${method}${hit.url} (guard ${hit.packId}#${hit.guardId}, ${hit.guardKind}).`,
    {
      pack_id: hit.packId,
      guard_id: hit.guardId,
      guard_kind: hit.guardKind,
      method: hit.method,
      url: hit.url,
    },
  );
}

/** The `SITE_PACED` warning (shown to operators): a write aborted by `pace-writes`. */
export function sitePaced(sessionId: string, hit: SiteGuardHitInput): SessionWarning {
  const method = hit.method === null ? '' : `${hit.method} `;
  return sessionWarning(
    'SITE_PACED',
    sessionId,
    `A write was paced and not sent: ${method}${hit.url} (guard ${hit.packId}#${hit.guardId}); the template's write budget for it is spent.`,
    {
      pack_id: hit.packId,
      guard_id: hit.guardId,
      guard_kind: hit.guardKind,
      method: hit.method,
      url: hit.url,
    },
  );
}
