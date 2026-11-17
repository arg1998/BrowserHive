/** @module infra/browsers/chain-preflights — the interception chain's CORS preflight side (D-66): arms the driver hook, runs the preflight-aware handlers, keeps the site's answers, and refuses preflighted requests while real preflights cannot be enforced (fail closed). */

import type { BrowserContext, Request } from 'patchright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Result } from '../../kernel/result.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import { needsPreflight } from './cors-request.ts';
import {
  installPreflightHook,
  type PreflightHook,
  type PreflightRequest,
  type PreflightVerdict,
} from './driver-preflights.ts';
import { PreflightCache } from './preflight-cache.ts';
import { type PreflightEnforcementState, preflightEnforcement } from './preflight-enforcement.ts';

/** What a handler answers about a preflight (the chain's `InterceptionVerdict`). */
export type HandlerVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'abort'; readonly reason: 'blockedbyclient' | 'failed' };

/** The part of an interception handler this module runs. */
export interface PreflightAwareHandler {
  readonly id: string;
  readonly onError: 'closed' | 'open';
  preflight?(preflight: PreflightRequest): Promise<HandlerVerdict>;
}

/** Arms the driver hook on a context (`installPreflightHook`, or a fake in tests). */
export type PreflightInstaller = (
  context: BrowserContext,
  hook: PreflightHook,
) => Result<'armed' | 'pending', Error>;

/** Collaborators of {@link ChainPreflights}. */
export interface ChainPreflightsDeps {
  /** The chain's handlers in run order, read on every preflight. */
  readonly handlers: () => readonly PreflightAwareHandler[];
  /** Turns whatever a handler returned into a verdict; throws on a malformed one. */
  readonly checked: (verdict: unknown) => HandlerVerdict;
  readonly log: Logger;
  readonly clock: Pick<Clock, 'now'>;
  readonly install?: PreflightInstaller;
  /** The process's enforcement state; `preflightEnforcement().state` when absent. */
  readonly driverState?: () => PreflightEnforcementState;
}

const CONTINUE: PreflightVerdict = Object.freeze({ kind: 'continue' });
const FAILED: PreflightVerdict = Object.freeze({ kind: 'abort', reason: 'failed' });

/**
 * One chain's preflight side. A chain whose hook is `armed` enforces while the process does; a
 * `pending` one (a context without pages) once the driver has been wrapped; a `refused` one never.
 * While it does not enforce, {@link refuses} tells the chain to fail every cross-origin request
 * Chromium preflights, because the driver answered that preflight without asking the site.
 */
export class ChainPreflights {
  private mode: 'none' | 'armed' | 'pending' | 'refused' = 'none';
  private readonly cacheOfAnswers: PreflightCache;
  private readonly install: PreflightInstaller;
  private readonly driverState: () => PreflightEnforcementState;

  constructor(private readonly deps: ChainPreflightsDeps) {
    this.cacheOfAnswers = new PreflightCache({ now: () => deps.clock.now() });
    this.install = deps.install ?? installPreflightHook;
    this.driverState = deps.driverState ?? (() => preflightEnforcement().state);
  }

  /** The site's answers this chain replays. */
  get cache(): PreflightCache {
    return this.cacheOfAnswers;
  }

  /** Whether the context's preflights are sent by Chromium and checked against the site's answer. */
  get enforced(): boolean {
    const state = this.driverState();
    if (this.mode === 'armed') return state !== 'refused';
    if (this.mode === 'pending') return state === 'enforced';
    return false;
  }

  /** Hands the context's preflights to {@link decide}. A refusal is logged; {@link refuses} acts on it. */
  arm(context: BrowserContext): void {
    try {
      const armed = this.install(context, {
        decide: (preflight) => this.decide(preflight),
        cache: this.cacheOfAnswers,
      });
      if (armed.ok) {
        this.mode = armed.value;
        return;
      }
      this.refused(armed.error);
    } catch (error) {
      this.refused(error);
    }
  }

  private refused(error: unknown): void {
    this.mode = 'refused';
    this.deps.log.error('preflight hook unavailable', { err: serializeError(error) });
  }

  /**
   * Runs the handlers that declare a `preflight` decision over a CORS preflight, in run order; the
   * first `abort` fails it. A `closed` handler that throws (or answers nothing valid) fails it, an
   * `open` one lets it go on. Never throws.
   */
  async decide(preflight: PreflightRequest): Promise<PreflightVerdict> {
    for (const handler of this.deps.handlers()) {
      if (handler.preflight === undefined) continue;
      let verdict: HandlerVerdict;
      try {
        verdict = this.deps.checked(await handler.preflight(preflight));
      } catch (error) {
        this.deps.log.error('interception handler threw', {
          handler: handler.id,
          preflight: true,
          err: serializeError(error),
        });
        if (handler.onError === 'closed') return FAILED;
        continue;
      }
      if (verdict.kind === 'abort') return verdict;
    }
    return CONTINUE;
  }

  /**
   * Whether the chain must fail `request` because its preflight was not enforced: the chain does
   * not enforce, and the request is one Chromium preflights (`needsPreflight`). A request that
   * cannot be read is refused unless it is a navigation.
   */
  refuses(request: Request): boolean {
    // Not installed: no route hands requests to the chain (only a test calls `handle` directly).
    if (this.mode === 'none' || this.enforced) return false;
    let resourceType = '?';
    let method = '?';
    let refuse: boolean;
    try {
      resourceType = request.resourceType();
      if (resourceType === 'document') return false;
      method = request.method();
      refuse = needsPreflight({
        url: request.url(),
        method,
        resourceType,
        headers: request.headers(),
      });
    } catch {
      refuse = resourceType !== 'document';
    }
    const facts = { method, resourceType };
    if (refuse) this.deps.log.warn('cors request refused', facts);
    return refuse;
  }
}
