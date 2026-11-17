/** @module app/site-packs/pacer — `pace-writes` with `ramp-up` (spec 13 §9.4, lead decision 5): one token bucket per (template, pack, pace rule), refilled continuously at `limit × ramp factor` per period, shared by every session of the template. A guarded write of kind `write` whose pack selects `pace-writes` and has pace rules naming its guard is held for its token (≤ 60 s, plus 0–20 % jitter) or refused. In memory: a restart refills every bucket. */

import type { PackPaceRule } from '@browserhive/contracts/site-packs';
import {
  holdMs,
  PACE_PERIOD_MS,
  type PaceBucket,
  type PaceBudget,
  planWrite,
  refund,
} from '../../domain/site-packs/pace.ts';
import { rampedLimit, rampFactor, strategyOf } from '../../domain/site-packs/strategy-specs.ts';
import { assertNever } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRepository, TemplateSiteRepository } from '../../ports/persistence/index.ts';
import type { GuardRuleDescriber } from '../../ports/site-guards.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { WritePaceRequest, WritePaceVerdict, WritePacing } from '../../ports/write-pacing.ts';
import { templateStrategies } from './strategy-scope.ts';

/** Collaborators of {@link WritePacer}. */
export interface WritePacerDeps {
  /** What a rule id means (pack, guard, kind). */
  readonly describe: GuardRuleDescriber;
  readonly lookup: SitePackLookup;
  /** The template's age (`created_at`) and its enabled sites' `ramp-up`. */
  readonly templates: Pick<TemplateRepository, 'get'>;
  readonly sites: Pick<TemplateSiteRepository, 'list'>;
  readonly clock: Clock;
  /** Uniform in `[0, 1)` (the hold's jitter). */
  readonly random: () => number;
  readonly logger: Logger;
}

const PASS: WritePaceVerdict = Object.freeze({ kind: 'pass' });

/** The write budgets of every template, in memory. */
export class WritePacer implements WritePacing {
  readonly #deps: WritePacerDeps;
  readonly #log: Logger;
  readonly #buckets = new Map<string, PaceBucket>();

  constructor(deps: WritePacerDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.pacer' });
  }

  async pace(request: WritePaceRequest): Promise<WritePaceVerdict> {
    const rules = this.#rulesOf(request.ruleId);
    if (rules === null) return PASS;
    const factor = await this.#rampFactor(request.templateId);
    // Synchronous from here on: no other write of this process interleaves with the buckets.
    const { clock } = this.#deps;
    const now = clock.now();
    const entries = rules.rules.map((rule) => ({
      key: `${request.templateId}\u0000${rules.packId}\u0000${rule.id}`,
      budget: budgetOf(rule, factor),
    }));
    const { plan, buckets } = planWrite(
      entries.map((e) => ({ bucket: this.#buckets.get(e.key), budget: e.budget })),
      now,
    );
    entries.forEach((e, i) => {
      const bucket = buckets[i];
      if (bucket !== undefined) this.#buckets.set(e.key, bucket);
    });
    switch (plan.kind) {
      case 'go':
        return PASS;
      case 'refuse':
        return { kind: 'refuse', retryAfterMs: plan.waitMs };
      case 'hold': {
        let released = false;
        return {
          kind: 'hold',
          holdMs: holdMs(plan.waitMs, this.#deps.random()),
          release: () => {
            if (released) return;
            released = true;
            for (const e of entries) {
              const bucket = this.#buckets.get(e.key);
              if (bucket !== undefined) {
                this.#buckets.set(e.key, refund(bucket, e.budget, clock.now()));
              }
            }
          },
        };
      }
      default:
        return assertNever(plan, 'pace plan');
    }
  }

  /** The pace rules governing a rule id, or `null` when the write is not paced. */
  #rulesOf(ruleId: string): { packId: string; rules: readonly PackPaceRule[] } | null {
    const info = this.#deps.describe(ruleId);
    if (info === null || info.guardKind !== 'write') return null;
    const pack = this.#deps.lookup.effectiveById(info.packId);
    if (pack === null || strategyOf(pack.pack, 'pace-writes') === null) return null;
    const rules = (pack.pack.pacing?.rules ?? []).filter((r) => r.guard === info.guardId);
    return rules.length === 0 ? null : { packId: pack.packId, rules };
  }

  /** The smallest `ramp-up` factor of the template's enabled sites (1 without one). */
  async #rampFactor(templateId: string): Promise<number> {
    try {
      const [template, sites] = await Promise.all([
        this.#deps.templates.get(templateId),
        this.#deps.sites.list(templateId),
      ]);
      if (template === null) return 1;
      const age = this.#deps.clock.now() - template.createdAt;
      let factor = 1;
      for (const s of templateStrategies(sites, this.#deps.lookup, 'ramp-up')) {
        factor = Math.min(factor, rampFactor(s.params, age));
      }
      return factor;
    } catch (err) {
      this.#log.warn('ramp factor unreadable', { templateId, err: serializeError(err) });
      return 1;
    }
  }
}

function budgetOf(rule: PackPaceRule, factor: number): PaceBudget {
  return { capacity: rampedLimit(rule.limit, factor), periodMs: PACE_PERIOD_MS[rule.per] };
}
