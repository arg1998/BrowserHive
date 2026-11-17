/** @module app/site-packs/tool-guard-hits — the tool path's `site_guard_hits` rows (spec 13 §9.3: every guard decision writes one row) for `block`, `warn` and `stop`: `source` `tool` (a `GET` document guard or a stop) or `element`, with the tool's name, through the `SiteGuardHitSink` (WP-E1's writer). A tool-path confirmation's row is written by the security intercepts when it settles. */

import { sanitizeUrl } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { SiteGuardKindValue } from '../../ports/persistence/site-packs.ts';
import type { SiteGuardHitSink } from '../../ports/site-guards.ts';

/** One tool-path decision. */
export interface ToolGuardHit {
  readonly sessionId: string;
  readonly templateId: string;
  readonly packId: string;
  readonly guardId: string;
  readonly guardKind: SiteGuardKindValue;
  readonly action: 'block' | 'warn';
  readonly source: 'tool' | 'element';
  readonly method: string | null;
  /** Raw; sanitized here (D-20). */
  readonly url: string;
  readonly tool: string;
}

/** Records tool-path guard decisions. */
export class ToolGuardHits {
  readonly #sink: () => SiteGuardHitSink | null;
  readonly #clock: Clock;

  /** `sink` is read per row (attached once the enforcement is built). */
  constructor(deps: { readonly sink: () => SiteGuardHitSink | null; readonly clock: Clock }) {
    this.#sink = deps.sink;
    this.#clock = deps.clock;
  }

  /** Writes one row; never throws (a lost audit row never fails the tool). */
  record(hit: ToolGuardHit): void {
    try {
      this.#sink()?.write({
        sessionId: hit.sessionId,
        templateId: hit.templateId,
        packId: hit.packId,
        guardId: hit.guardId,
        guardKind: hit.guardKind,
        action: hit.action,
        outcome: null,
        decidedBy: null,
        source: hit.source,
        method: hit.method,
        url: sanitizeUrl(hit.url),
        requestId: null,
        tool: hit.tool,
        ts: this.#clock.now(),
      });
    } catch {
      // The writer counts and logs its own failures.
    }
  }
}
