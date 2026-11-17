/** @module app/site-packs/tool-guard-hits — the tool path's `site_guard_hits` rows (spec 13 §9.3: every guard decision writes one row): `source` `tool` (a `GET` document guard or a stop on `navigate`/`new_tab`) or `element`, with the tool's name. Written through the recorder's write queue, never awaited by a tool. */

import { sanitizeUrl } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type {
  SiteGuardActionValue,
  SiteGuardHitRecord,
  SiteGuardKindValue,
  SiteGuardOutcomeValue,
} from '../../ports/persistence/site-packs.ts';

/** Where hit rows go (composition: the write queue's `site_guard_hits.insert`). */
export type SiteGuardHitSink = (record: SiteGuardHitRecord) => void;

/** One tool-path decision. */
export interface ToolGuardHit {
  readonly sessionId: string;
  readonly templateId: string;
  readonly packId: string;
  readonly guardId: string;
  readonly guardKind: SiteGuardKindValue;
  readonly action: SiteGuardActionValue;
  readonly outcome?: SiteGuardOutcomeValue | null;
  readonly source: 'tool' | 'element';
  readonly method: string | null;
  /** Raw; sanitized here (D-20). */
  readonly url: string;
  readonly requestId?: string | null;
  readonly tool: string;
}

/** Records tool-path guard decisions. */
export class ToolGuardHits {
  readonly #sink: SiteGuardHitSink;
  readonly #ids: Pick<IdGenerator, 'eventId'>;
  readonly #clock: Clock;

  constructor(deps: {
    readonly sink: SiteGuardHitSink;
    readonly ids: Pick<IdGenerator, 'eventId'>;
    readonly clock: Clock;
  }) {
    this.#sink = deps.sink;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
  }

  /** Writes one row; never throws (a lost audit row never fails the tool). */
  record(hit: ToolGuardHit): void {
    try {
      this.#sink({
        eventId: this.#ids.eventId(),
        sessionId: hit.sessionId,
        templateId: hit.templateId,
        packId: hit.packId,
        guardId: hit.guardId,
        guardKind: hit.guardKind,
        action: hit.action,
        outcome: hit.outcome ?? null,
        decidedBy: null,
        source: hit.source,
        method: hit.method,
        url: sanitizeUrl(hit.url),
        requestId: hit.requestId ?? null,
        tool: hit.tool,
        ts: this.#clock.now(),
      });
    } catch {
      // The write queue refuses when closed or full and counts the drop itself.
    }
  }
}
