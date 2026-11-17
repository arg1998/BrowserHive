/** @module domain/site-packs/classify-types — the vocabulary of `classifyPackChange` (spec 13 §9.7): the four classes, the templates a pack's floor is checked against, and the classified diff. */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import type { SitePackChangeFieldRecord } from '../../ports/persistence/site-packs.ts';
import type { StealthSettings } from './stealth-floor.ts';

/** The class of one change (spec 13 §9.7). */
export type ChangeClass = 'tightening' | 'restrictive' | 'loosening' | 'neutral';

/** A template whose enabled site uses the pack (the `stealth-profile` restrictive rule). */
export interface UsingTemplate extends StealthSettings {
  readonly templateId: string;
  readonly name: string;
}

/** What the classifier reads besides the two versions. */
export interface ClassifyContext {
  readonly usingTemplates: readonly UsingTemplate[];
}

/** No template uses the pack. */
export const NO_TEMPLATES: ClassifyContext = Object.freeze({ usingTemplates: [] });

/** One classified field change. */
export interface ClassifiedChange extends SitePackChangeFieldRecord {
  readonly class: ChangeClass | null;
}

/** A candidate's classification and its field-level diff with each field's class. */
export interface PackChangeClassification {
  /** `new_pack` when nothing was approved before (its fields are left unclassified). */
  readonly classification: ChangeClass | 'new_pack';
  readonly changes: readonly ClassifiedChange[];
}

/** Both versions and the context, as every rule reads them. */
export interface ClassifyInput {
  readonly from: SitePackV1;
  readonly to: SitePackV1;
  readonly ctx: ClassifyContext;
}
