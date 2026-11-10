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

/**
 * The effective live-session cap of a template (spec 13 §6.3): `max_concurrent`, later bounded by
 * the enabled sites' packs (`concurrency.max_sessions`, T3a) and scaled by `ramp-up` (T3b).
 */
export function effectiveCap(template: TemplateRecord): number {
  return template.maxConcurrent;
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
 * - `unavailable`: not `ready`, or its browser cannot run until the operator acts (`failed`);
 * - `needs_login`: every enabled site is `signed_out` or `challenged`;
 * - `busy`: at its session cap, or briefly unable to admit (`draining`, `crashed`);
 * - `available`: a launch would be admitted now (a stopped browser starts on launch).
 */
export function availabilityOf(
  template: TemplateRecord,
  sites: readonly TemplateSiteRecord[],
  host: TemplateHostFacts,
): Availability {
  if (template.status !== 'ready' || host.state === 'failed') return 'unavailable';
  const enabled = sites.filter((s) => s.enabled);
  if (enabled.length > 0 && enabled.every((s) => OUT.has(s.health.state))) return 'needs_login';
  if (host.state === 'draining' || host.state === 'crashed') return 'busy';
  if (host.liveAgentSessions >= effectiveCap(template)) return 'busy';
  return 'available';
}
