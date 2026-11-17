/** @module domain/templates/model — pure rules over a session template: access, sealing, capacity and what an agent is told about availability (spec 13 §5.1, §5.4, §6; D-51, D-52, D-56). */

import type {
  TemplateHealthState,
  TemplateRecord,
  TemplateSiteRecord,
  TemplateUnsealRecord,
} from '../../ports/persistence/index.ts';
import {
  type AccessSubject,
  type AccessVerdict,
  checkTemplateAccess,
  type TemplateAccessRule,
} from '../policies/access-rule.ts';

/** The grant a template expresses (spec 13 §6.1). */
export function templateAccessRule(template: TemplateRecord): TemplateAccessRule {
  return { principals: template.authorizedPrincipals, harnesses: template.harnesses };
}

/** Why a template is not usable by a caller (operator surfaces only). */
export type TemplateRefusal = 'recording' | 'principal_not_allowed' | 'harness_not_allowed';

/**
 * The template gate of spec 13 §6.1, in order: the template is not `recording` → principal →
 * harness. Every refusal looks like absence to the agent (`TEMPLATE_NOT_FOUND`); the reason is for
 * the operator's log and access tester only.
 */
export function templateGate(
  template: TemplateRecord,
  subject: AccessSubject,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: TemplateRefusal } {
  if (template.status === 'recording') return { allowed: false, reason: 'recording' };
  const verdict: AccessVerdict = checkTemplateAccess(templateAccessRule(template), subject);
  return verdict;
}

/** `true` while no unseal flag is set (the template's operator-facing "Sign-ins protected"). */
export function isTemplateSealed(unseal: TemplateUnsealRecord): boolean {
  return !(unseal.cookieValues || unseal.evaluate || unseal.cookieWrites || unseal.stateExport);
}

/**
 * The protections in force for one principal's sessions of a template (spec 13 §5.4). Every flag is
 * on (sealed) unless the operator unsealed it, for every principal (`principals` `null` or empty) or
 * for this one.
 */
export interface SessionSealing {
  /** `get_cookies` returns empty values for the template's sites only, plus `sealed: true`. */
  readonly hideCookieValues: boolean;
  /** `disable_evaluate` is forced `true`. */
  readonly forceDisableEvaluate: boolean;
  /** `set_cookies` answers `SESSION_SEALED`. */
  readonly refuseCookieWrites: boolean;
  /** `save_storage_state` answers `SESSION_SEALED`. */
  readonly refuseStateExport: boolean;
}

/** Computes {@link SessionSealing} for `principal`. */
export function sealingFor(unseal: TemplateUnsealRecord, principal: string): SessionSealing {
  const applies =
    unseal.principals === null ||
    unseal.principals.length === 0 ||
    unseal.principals.includes(principal);
  return {
    hideCookieValues: !(applies && unseal.cookieValues),
    forceDisableEvaluate: !(applies && unseal.evaluate),
    refuseCookieWrites: !(applies && unseal.cookieWrites),
    refuseStateExport: !(applies && unseal.stateExport),
  };
}

/** Whether any protection is in force (`sessions.sealed`, `list_templates.sealed`). */
export function isSessionSealed(sealing: SessionSealing): boolean {
  return (
    sealing.hideCookieValues ||
    sealing.forceDisableEvaluate ||
    sealing.refuseCookieWrites ||
    sealing.refuseStateExport
  );
}

/** What the enabled sites' packs do to a template's cap (spec 13 §6.3, §9.4, §9.10). */
export interface CapLimits {
  /** The smallest `concurrency.max_sessions` of the enabled sites' packs; `null` = none. */
  readonly siteMax: number | null;
  /** The smallest `ramp-up` factor (1 = no ramp). */
  readonly rampFactor: number;
}

/** No pack limits (packs off, or no enabled site's pack sets one). */
export const NO_CAP_LIMITS: CapLimits = Object.freeze({ siteMax: null, rampFactor: 1 });

/**
 * The effective live-session cap of a template (spec 13 §6.3): `min(max_concurrent, the enabled
 * sites' pack concurrency.max_sessions)` (never above `max_concurrent`, §9.10), scaled by the
 * `ramp-up` factor and rounded up, never below 1.
 */
export function effectiveCap(template: TemplateRecord, limits: CapLimits = NO_CAP_LIMITS): number {
  const base = Math.min(template.maxConcurrent, limits.siteMax ?? template.maxConcurrent);
  const factor = Math.min(1, Math.max(0, limits.rampFactor));
  // A hair below the integer first: 10 × 0.6 is 6.000000000000001 in binary floating point.
  return Math.max(1, Math.ceil(base * factor - 1e-9));
}

/** Agent page limits for one host (spec 13 §6.3, D-56). */
export interface PageCaps {
  /** Agent pages per host (`templateMaxPagesPerHost`). */
  readonly host: number;
  /** Agent pages per session: `max(2, floor(host / cap))`, so one session cannot take every page. */
  readonly perSession: number;
}

/** Computes {@link PageCaps}. */
export function pageCaps(maxPagesPerHost: number, cap: number): PageCaps {
  return { host: maxPagesPerHost, perSession: Math.max(2, Math.floor(maxPagesPerHost / cap)) };
}

/** What the host side knows about a template right now (from the host supervisor, templates T1a-2). */
export interface TemplateHostFacts {
  readonly state: 'stopped' | 'starting' | 'running' | 'draining' | 'crashed' | 'failed';
  /** Live agent virtual sessions (maintenance sessions excluded). */
  readonly liveAgentSessions: number;
}

/** What `list_templates` tells an agent (spec 13 §5.1). */
export type Availability = 'available' | 'busy' | 'needs_login' | 'unavailable';

const OUT: ReadonlySet<TemplateHealthState> = new Set(['signed_out', 'challenged']);

/**
 * The agent-facing availability of a ready or disabled template (spec 13 §5.1):
 * - `unavailable`: not `ready`, its browser cannot run until the operator acts (`failed`), or every
 *   site is disabled;
 * - `needs_login`: every enabled site is `signed_out` or `challenged`;
 * - `busy`: at its session cap, or briefly unable to admit (`draining`, `crashed`);
 * - `available`: a launch would be admitted now (a stopped browser starts on launch).
 */
export function availabilityOf(
  template: TemplateRecord,
  sites: readonly TemplateSiteRecord[],
  host: TemplateHostFacts,
  cap: number = effectiveCap(template),
): Availability {
  const enabled = sites.filter((s) => s.enabled);
  // A template with every site disabled offers nothing to sign in to until the operator acts.
  if (template.status !== 'ready' || host.state === 'failed' || enabled.length === 0) {
    return 'unavailable';
  }
  if (enabled.every((s) => OUT.has(s.health.state))) return 'needs_login';
  if (host.state === 'draining' || host.state === 'crashed') return 'busy';
  if (host.liveAgentSessions >= cap) return 'busy';
  return 'available';
}

/**
 * The extra scope watching a template session needs (its live view and screenshots, spec 13
 * §11.1): `templates:login` for a maintenance session (a recording shows the operator typing),
 * `templates:read` for an agent's template session, none for an exclusive session.
 */
export function templateViewScope(
  template: { readonly mode: 'live' | 'maintenance' } | null | undefined,
): 'templates:read' | 'templates:login' | null {
  if (template == null) return null;
  return template.mode === 'live' ? 'templates:read' : 'templates:login';
}
