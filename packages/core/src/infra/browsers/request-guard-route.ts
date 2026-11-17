/** @module infra/browsers/request-guard-route — the method- and resource-type-aware request guard as the interception chain's last handler (spec 13 §3.8 handler 3, §9.3, D-54). */

import type { Request } from 'patchright';
import {
  matchRequestGuard,
  type RequestGuardMatch,
  type RequestGuardRuleSource,
} from '../../domain/policies/request-guard.ts';
import { assertNever } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { sanitizeUrl } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  RequestConfirmer,
  RequestConfirmResult,
  RequestGuardHit,
  RequestGuardHits,
  RequestOwner,
} from '../../ports/request-guard.ts';
import type { WritePaceVerdict } from '../../ports/write-pacing.ts';
import {
  type InterceptionContext,
  type InterceptionHandler,
  type InterceptionVerdict,
  PASS,
} from './interception-chain.ts';

/** Collaborators of {@link requestGuardHandler}. */
export interface RequestGuardHandlerDeps {
  /** Read on every request (hot reload). */
  readonly rules: RequestGuardRuleSource;
  readonly hits: RequestGuardHits;
  /**
   * Who answers a `confirm` rule. `null` (no operator can answer: `transport=stdio`, or no
   * confirmation flow wired yet) makes `confirm` act as `block` (spec 13 §9.3).
   */
  readonly confirmer: RequestConfirmer | null;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Query keys kept in audited URLs (`urlQueryAllowlist`, D-20). */
  readonly urlQueryAllowlist?: readonly string[];
  /**
   * `pace-writes` for this host's template (spec 13 §9.4): asked before the action of every
   * matched rule except `block`; absent or `null` = no pacing.
   */
  readonly pace?: ((ruleId: string) => Promise<WritePaceVerdict>) | null;
}

const ABORT_BLOCKED: InterceptionVerdict = Object.freeze({
  kind: 'abort',
  reason: 'blockedbyclient',
});
const ABORT_FAILED: InterceptionVerdict = Object.freeze({ kind: 'abort', reason: 'failed' });

/**
 * The request guard: every routed request is matched by URL, method and resource type
 * (`matchRequestGuard`); the first matching rule decides.
 *
 * | Rule action | Request | Hit |
 * |---|---|---|
 * | `allow` | passes (the owner is never resolved) | none |
 * | `warn` | passes at once | `warn`, recorded once the owner resolves |
 * | `block` | aborted `blockedbyclient` at once | `block`, recorded once the owner resolves |
 * | `confirm` | **held** until the confirmer answers; `approved` passes, anything else is aborted | `confirm` with the outcome |
 * | `confirm`, no confirmer | aborted `blockedbyclient` at once | `block` (rule action `confirm`) |
 * | `confirm`, answered `asBlock` | aborted `blockedbyclient` | `block` (rule action `confirm`) |
 *
 * **Pacing** (`pace-writes`, spec 13 §9.4) runs before the action of an `allow`, `warn` or `confirm`
 * rule: a write over budget is held for its token (hit `held` once it goes on to the action) or
 * aborted `blockedbyclient` (hit `paced`, plus a `SITE_PACED` warning on the owning session). A
 * held write whose request goes away is aborted and its token given back.
 *
 * Only `confirm` waits for the owner before deciding (the operator request goes to the owning
 * session); a resolver that holds a frameless popup navigation (PR T1a) delays nothing else. A
 * hit whose owner cannot be resolved is recorded with `sessionId: null`.
 *
 * Failure handling. Before a rule matched (reading the request, the rule source, the matcher),
 * an exception goes to the chain, which aborts document requests and passes the rest (`onError:
 * 'closed'`, the blocklist's rule). After a rule matched, the request is known to be one the
 * guard governs, so any failure (the owner of a `confirm`, the confirmer, an action the guard does
 * not know) aborts it with `failed` whatever its type, and no hit is recorded (the error is
 * logged). The hit sink failing never changes a decision.
 */
export function requestGuardHandler(deps: RequestGuardHandlerDeps): InterceptionHandler {
  const log = deps.logger.child({ module: 'request-guard' });
  const allow = deps.urlQueryAllowlist ?? [];

  const record = (hit: RequestGuardHit): void => {
    try {
      deps.hits.record(hit);
    } catch (error) {
      log.warn('guard hit not recorded', { ruleId: hit.ruleId, err: serializeError(error) });
    }
  };

  /** Records `hit` once the owner resolves, without holding the request for it. */
  const recordLater = (
    context: InterceptionContext,
    hit: (sessionId: string | null) => RequestGuardHit,
  ): void => {
    void Promise.resolve()
      .then(() => context.owner())
      .then(
        (owner) => record(hit(sessionOf(owner))),
        (error: unknown) => {
          log.warn('guard hit owner unknown', { err: serializeError(error) });
          record(hit(null));
        },
      );
  };

  const decide = async (
    match: RequestGuardMatch,
    facts: { method: string; resourceType: string; url: string },
    context: InterceptionContext,
  ): Promise<InterceptionVerdict> => {
    const rule = match.rule;
    let ts = deps.clock.now();
    const hit =
      (fields: Pick<RequestGuardHit, 'ruleAction' | 'action'>) =>
      (sessionId: string | null): RequestGuardHit => ({
        sessionId,
        ruleId: rule.id,
        method: facts.method,
        resourceType: facts.resourceType,
        url: facts.url,
        source: 'request',
        outcome: null,
        decidedBy: null,
        requestId: null,
        ts,
        ...fields,
      });
    const fields = { ruleId: rule.id, method: facts.method, url: facts.url };
    if (rule.action !== 'block' && deps.pace != null) {
      const verdict = await deps.pace(rule.id);
      const paced = await pacing(verdict, context, fields, (action) =>
        hit({ ruleAction: rule.action, action }),
      );
      if (paced !== null) return paced;
      // A held write meets its action when it goes on.
      ts = deps.clock.now();
    }
    switch (rule.action) {
      case 'allow':
        return PASS;
      case 'warn':
        recordLater(context, hit({ ruleAction: 'warn', action: 'warn' }));
        log.info('guarded request warned', fields);
        return PASS;
      case 'block':
        recordLater(context, hit({ ruleAction: 'block', action: 'block' }));
        log.info('guarded request blocked', fields);
        return ABORT_BLOCKED;
      case 'confirm': {
        if (deps.confirmer === null) {
          recordLater(context, hit({ ruleAction: 'confirm', action: 'block' }));
          log.info('guarded request blocked', { ...fields, reason: 'no_confirmer' });
          return ABORT_BLOCKED;
        }
        const owner = await context.owner();
        log.info('guarded request held', fields);
        const answer: RequestConfirmResult = await deps.confirmer.confirm({
          owner,
          ruleId: rule.id,
          method: facts.method,
          resourceType: facts.resourceType,
          url: facts.url,
          signal: context.signal(),
        });
        if (answer.asBlock === true) {
          record(hit({ ruleAction: 'confirm', action: 'block' })(sessionOf(owner)));
          log.info('guarded request blocked', { ...fields, reason: 'not_confirmable' });
          return ABORT_BLOCKED;
        }
        record({
          ...hit({ ruleAction: 'confirm', action: 'confirm' })(sessionOf(owner)),
          outcome: answer.outcome,
          decidedBy: answer.decidedBy,
          requestId: answer.requestId,
          ts: deps.clock.now(),
        });
        log.info('guarded request decided', { ...fields, outcome: answer.outcome });
        return answer.outcome === 'approved' ? PASS : ABORT_BLOCKED;
      }
      default:
        // A rule set built without `compileRequestGuardRules` (it refuses unknown actions).
        return assertNever(rule.action, 'request guard action');
    }
  };

  /**
   * Applies a pace verdict: `null` when the write goes on to the rule's action (not paced, or held
   * until its token), an abort when refused or when the held request went away.
   */
  const pacing = async (
    verdict: WritePaceVerdict,
    context: InterceptionContext,
    fields: Readonly<Record<string, string>>,
    hit: (action: 'paced' | 'held') => (sessionId: string | null) => RequestGuardHit,
  ): Promise<InterceptionVerdict | null> => {
    switch (verdict.kind) {
      case 'pass':
        return null;
      case 'refuse':
        recordLater(context, hit('paced'));
        log.info('guarded write paced', { ...fields, retryAfterMs: verdict.retryAfterMs });
        return ABORT_BLOCKED;
      case 'hold': {
        try {
          await deps.clock.sleep(verdict.holdMs, context.signal());
        } catch {
          verdict.release();
          log.info('held write went away', fields);
          return ABORT_BLOCKED;
        }
        const at = deps.clock.now();
        recordLater(context, (sessionId) => ({ ...hit('held')(sessionId), ts: at }));
        log.info('guarded write held', { ...fields, holdMs: verdict.holdMs });
        return null;
      }
      default:
        return assertNever(verdict, 'pace verdict');
    }
  };

  return {
    id: 'request-guard',
    onError: 'closed',
    handle: async (request: Request, context) => {
      const rawUrl = request.url();
      const method = request.method().toUpperCase();
      const resourceType = request.resourceType();
      const match = matchRequestGuard(deps.rules.rulesFor(rawUrl), {
        url: rawUrl,
        method,
        resourceType,
      });
      if (match === null) return PASS;
      const url = sanitizeUrl(rawUrl, { allowQueryKeys: allow });
      try {
        return await decide(match, { method, resourceType, url }, context);
      } catch (error) {
        log.error('request guard failed', {
          ruleId: match.rule.id,
          url,
          err: serializeError(error),
        });
        return ABORT_FAILED;
      }
    },
  };
}

function sessionOf(owner: RequestOwner): string | null {
  return owner.kind === 'session' ? owner.sessionId : null;
}
