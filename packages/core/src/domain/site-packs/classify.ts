/** @module domain/site-packs/classify — `classifyPackChange` (spec 13 §9.7): every change from the approved version to a candidate classified field by field, **default deny** (a field or strategy parameter without a rule is loosening), the candidate's class the strongest of its fields (loosening > restrictive > tightening > neutral). The rules per field are in `classify-fields.ts`, `classify-rules.ts` (guards and challenges) and `classify-strategies.ts`. */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { classifyField } from './classify-fields.ts';
import type {
  ChangeClass,
  ClassifyContext,
  ClassifyInput,
  PackChangeClassification,
} from './classify-types.ts';
import { NO_TEMPLATES } from './classify-types.ts';
import { diffPacks } from './diff.ts';

export type {
  ChangeClass,
  ClassifiedChange,
  ClassifyContext,
  PackChangeClassification,
  UsingTemplate,
} from './classify-types.ts';
export { NO_TEMPLATES } from './classify-types.ts';

const RANK: Readonly<Record<ChangeClass, number>> = {
  neutral: 0,
  tightening: 1,
  restrictive: 2,
  loosening: 3,
};

/** The strongest of `classes` (`neutral` for none). */
export function strongestClass(classes: Iterable<ChangeClass>): ChangeClass {
  let best: ChangeClass = 'neutral';
  for (const c of classes) if (RANK[c] > RANK[best]) best = c;
  return best;
}

/**
 * Classifies the change from `from` (the approved version, `null` for none) to `to` (spec 13 §9.7).
 * A candidate with no field change is `neutral`.
 */
export function classifyPackChange(
  from: SitePackV1 | null,
  to: SitePackV1,
  ctx: ClassifyContext = NO_TEMPLATES,
): PackChangeClassification {
  const diff = diffPacks(from, to);
  if (from === null) {
    return { classification: 'new_pack', changes: diff.map((c) => ({ ...c, class: null })) };
  }
  const input: ClassifyInput = { from, to, ctx };
  const changes = diff.map((c) => ({ ...c, class: classifyField(c, input) }));
  return { classification: strongestClass(changes.map((c) => c.class)), changes };
}
