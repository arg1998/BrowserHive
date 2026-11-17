/** @module ports/site-tool-guards — what the tool layer asks the network enforcement (spec 13 §9.3): the `GET` document guard a navigation hits, resolved from the host's own rule source. */

import type { PackGuardKind } from '@browserhive/contracts/site-packs';
import type { RequestGuardAction } from '../domain/policies/request-guard.ts';

/** The guard a `GET` document load hits. */
export interface DocumentGuardHit {
  /** `<pack id>#<guard id>` (the `URL_BLOCKED` pattern). */
  readonly ruleId: string;
  /** The pack's id, or `browserhive` for `DEFAULT_GUARDS`. */
  readonly packId: string;
  readonly guardId: string;
  readonly kind: PackGuardKind;
  /** The effective action (`write_policy` resolved; `allow` lets the load through). */
  readonly action: RequestGuardAction;
}

/** Resolves the `GET` document guard of `url` on a template's host, or `null`. Never throws. */
export type DocumentGuardResolver = (templateId: string, url: string) => DocumentGuardHit | null;
