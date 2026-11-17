/** @module domain/site-packs/classify-test-kit — builds a candidate from the LinkedIn-shaped base pack and classifies it, for the per-field tests of `classifyPackChange` (spec 13 §9.7). */

import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import { type ClassifyContext, classifyPackChange, NO_TEMPLATES } from './classify.ts';
import { basePack } from './test-fixtures.ts';

/** A copy of the base pack, edited by `edit`, then parsed (defaults applied). */
export function packWith(edit?: (pack: SitePackV1Input) => void): SitePackV1 {
  const input = structuredClone(basePack());
  edit?.(input);
  return SitePackV1.parse(input);
}

/** Classifies `edit(base)` against `base` after `before(base)`; returns the overall class and each path's class. */
export function classOf(
  edit: (pack: SitePackV1Input) => void,
  options: { before?: (pack: SitePackV1Input) => void; ctx?: ClassifyContext } = {},
): { overall: string; fields: Record<string, string | null> } {
  const from = packWith(options.before);
  const to = packWith((p) => {
    options.before?.(p);
    edit(p);
  });
  const result = classifyPackChange(from, to, options.ctx ?? NO_TEMPLATES);
  const fields: Record<string, string | null> = {};
  for (const c of result.changes) fields[c.path] = c.class;
  return { overall: result.classification, fields };
}
