/** @module domain/site-packs/default-guards — `DEFAULT_GUARDS` (spec 13 §9.3): `credential` guards (`block`) for the OAuth consent approval endpoints of the big identity providers, compiled into the binary and applied on every template host page whether or not the site has a pack, after the owning pack's own guards. */

import type { PackGuardKind } from '@browserhive/contracts/site-packs';
import type { GuardMethod, GuardResourceType } from '../policies/request-guard.ts';

/** The pack id default-guard hits are recorded under; rule ids are `browserhive#<id>`. */
export const DEFAULT_GUARDS_ID = 'browserhive';

/** One built-in guard. */
export interface DefaultGuard {
  /** The guard id (rule id `browserhive#<id>`). */
  readonly id: string;
  readonly kind: PackGuardKind;
  /** The provider, shown where a pack title would be ("Google"). */
  readonly title: string;
  /** A spec 11 §5 glob (guard grammar: no trailing `*` also matches a query string and sub-paths). */
  readonly url: string;
  /** Absent: every method. */
  readonly methods?: readonly GuardMethod[];
  /** Absent: document, xhr, fetch and ping. */
  readonly resourceTypes?: readonly GuardResourceType[];
  readonly action: 'block';
}

/**
 * The built-in consent guards: approving an OAuth grant hands a third party a token for the
 * account, which no agent may do in an operator's signed-in browser. Order is the match order.
 * Verified on 2026-11-16 against the providers' signed-out flows and documentation (evidence in
 * `scratchpad/session-templates/t3a-packs/DEFAULT_GUARDS.json`); where the approval request itself
 * is only reachable signed in, the guard is an item of the owner's signed-in checklist.
 */
export const DEFAULT_GUARDS: readonly DefaultGuard[] = Object.freeze([
  {
    // Observed: OAuth consent redirects to /signin/oauth/v3/consent. Approval request not
    // observable signed out (owner checklist item): every method on the consent pages is blocked.
    id: 'google-oauth-consent',
    kind: 'credential',
    title: 'Google',
    url: 'accounts.google.com/signin/oauth/*consent*',
    action: 'block',
  },
  {
    // docs.github.com "Authorizing OAuth apps": GET /login/oauth/authorize is the request; the
    // Authorize POST is not observable signed out (owner checklist item). GET stays open so
    // already-authorized apps keep their silent redirect.
    id: 'github-oauth-approve',
    kind: 'credential',
    title: 'GitHub',
    url: 'github.com/login/oauth/authorize*',
    methods: ['POST'],
    action: 'block',
  },
  {
    // docs.github.com device flow: verification at /login/device; the code entry and approval
    // POSTs are not observable signed out (owner checklist item).
    id: 'github-device-approve',
    kind: 'credential',
    title: 'GitHub',
    url: 'github.com/login/device*',
    methods: ['POST'],
    action: 'block',
  },
  {
    // learn.microsoft.com v2-admin-consent: /{tenant}/v2.0/adminconsent (and the v1 form).
    id: 'entra-admin-consent',
    kind: 'credential',
    title: 'Microsoft',
    url: 'login.microsoftonline.com/*adminconsent*',
    action: 'block',
  },
  {
    // Observed: account.live.com/consent/Manage exists (redirects to sign-in); the MSA consent
    // approval request is not observable signed out (owner checklist item).
    id: 'msa-consent',
    kind: 'credential',
    title: 'Microsoft',
    url: 'account.live.com/consent',
    action: 'block',
  },
]);

/** The rule id of a default guard. */
export function defaultGuardRuleId(id: string): string {
  return `${DEFAULT_GUARDS_ID}#${id}`;
}
