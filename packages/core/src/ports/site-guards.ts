/** @module ports/site-guards — what the request guard's rule ids mean (a pack guard or a `DEFAULT_GUARDS` entry), a template site's write-policy override, and the internal bus events of guard hits and write confirmations (spec 13 §9.3, §9.9, §11.3). */

import type { SiteGuardHitRow } from '@browserhive/contracts/http';
import type { PackGuardKind } from '@browserhive/contracts/site-packs';
import type { SiteWritePolicy } from './persistence/enums.ts';
import type {
  SiteGuardActionValue,
  SiteGuardKindValue,
  SiteGuardOutcomeValue,
  SiteGuardSourceValue,
} from './persistence/site-packs.ts';

/** What a request-guard rule id (`<pack id>#<guard id>`) stands for. */
export interface GuardRuleInfo {
  readonly ruleId: string;
  /** The pack's id, or `browserhive` for `DEFAULT_GUARDS`. */
  readonly packId: string;
  /** The guard's id inside its pack. */
  readonly guardId: string;
  readonly guardKind: PackGuardKind;
  /** The pack's title ("LinkedIn"), or the default guard's provider ("Google"). */
  readonly siteTitle: string;
}

/** Resolves a rule id the guard reported; `null` for an id no rule source produced. */
export type GuardRuleDescriber = (ruleId: string) => GuardRuleInfo | null;

/** A template site's write-policy override, read synchronously on every request. */
export interface WritePolicyOverrides {
  /**
   * The override of the template site that this pack covers (its `pack_id`, else a site whose
   * registrable domain is one of the pack's domains); `null` = the pack's default.
   */
  overrideFor(
    templateId: string,
    pack: { readonly id: string; readonly domains: readonly string[] },
  ): SiteWritePolicy | null;
}

/** `site_pack.guard_hit` (internal bus event, spec 13 §11.3): one `site_guard_hits` row. */
export interface SiteGuardHitEvent {
  readonly type: 'site_pack.guard_hit';
  readonly row: SiteGuardHitRow;
}

/**
 * `site_pack.confirm` (internal bus event): a write confirmation of a template site opened or
 * settled; `open` is how many of that template site's write confirmations are open now. The
 * `site_pack.write_confirm` notification is built from it (spec 13 §8.6).
 */
export interface SiteConfirmEvent {
  readonly type: 'site_pack.confirm';
  readonly phase: 'opened' | 'settled';
  readonly template_id: string;
  /** The template's display name (notification titles). */
  readonly template_name: string;
  /** The registrable domain. */
  readonly site: string;
  readonly site_title: string;
  readonly open: number;
  /** The request that opened or settled. */
  readonly request_id: string;
  readonly session_id: string;
  readonly guard: { readonly pack_id: string; readonly id: string; readonly kind: PackGuardKind };
  readonly method: string | null;
  /** Sanitized (D-20). */
  readonly url: string;
  readonly tool: string | null;
  /** Settled only: the request's terminal status. */
  readonly status?: 'resolved' | 'rejected' | 'timeout' | 'cancelled';
  readonly at: number;
}

/** The events the site-pack enforcement publishes. */
export type SiteGuardEvents = {
  readonly 'site_pack.guard_hit': SiteGuardHitEvent;
  readonly 'site_pack.confirm': SiteConfirmEvent;
};

/** One guard decision from any path (the network guard, or the tool layer's element and navigation guards). */
export interface SiteGuardHitInput {
  /** `null` for a host-owned request. */
  readonly sessionId: string | null;
  readonly templateId: string | null;
  readonly packId: string;
  readonly guardId: string;
  readonly guardKind: SiteGuardKindValue;
  readonly action: SiteGuardActionValue;
  readonly outcome: SiteGuardOutcomeValue | null;
  readonly decidedBy: string | null;
  readonly source: SiteGuardSourceValue;
  readonly method: string | null;
  /** Sanitized (D-20). */
  readonly url: string;
  readonly requestId: string | null;
  /** The tool call that triggered it (`null` on the network path). */
  readonly tool: string | null;
  readonly ts: number;
}

/** Where guard decisions are written (`site_guard_hits`, spec 13 §9.9). Never throws. */
export interface SiteGuardHitSink {
  write(input: SiteGuardHitInput): void;
}
