/** @module domain/site-packs/tool-guards — the tool layer's view of a pack's element guards (spec 13 §9.3): effective actions under the write policy and the guards of a page. Pure matching over pack data; the page is queried elsewhere. The `GET` document guards come from the network guard's rule source (WP-E1). */

import type {
  PackElementGuard,
  PackGuardAction,
  SitePackV1,
} from '@browserhive/contracts/site-packs';
import type { RequestGuardAction } from '../policies/request-guard.ts';
import { matchesPackGlob } from './pack-glob.ts';

/** A site's write policy (`template_sites.write_policy`, else the pack's `write_policy.default`). */
export type WritePolicy = SitePackV1['write_policy']['default'];

/** The write policy in force: the template site's override, else the pack's default (§9.3). */
export function effectiveWritePolicy(pack: SitePackV1, override: WritePolicy | null): WritePolicy {
  return override ?? pack.write_policy.default;
}

/** A guard's action with `write_policy` resolved (`allow` lets the action through, unrecorded). */
export function effectiveAction(action: PackGuardAction, policy: WritePolicy): RequestGuardAction {
  return action === 'write_policy' ? policy : action;
}

/** The element guards of `pack` whose `page` glob matches `pageUrl`, in pack order. */
export function elementGuardsFor(pack: SitePackV1, pageUrl: string): readonly PackElementGuard[] {
  return pack.element_guards.filter((guard) => matchesPackGlob(guard.page, pageUrl));
}
