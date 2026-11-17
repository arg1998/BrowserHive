/** @module domain/site-packs/stealth-floor — the `stealth-profile` floor (spec 13 §9.4): what a template's stealth settings must be for a site whose pack selects it. Checked at template creation, site add, template edits and pack approval. */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { type StrategyParams, strategyOf } from './strategy-specs.ts';

/** The template settings the floor reads. */
export interface StealthSettings {
  readonly stealth: 'off' | 'standard' | 'max';
  readonly fingerprint: boolean;
}

/** One way a template is below a pack's floor. */
export interface StealthFloorIssue {
  readonly code: 'stealth_below_floor' | 'fingerprint_required' | 'fingerprint_forbidden';
  readonly message: string;
}

const LEVEL: Readonly<Record<StealthSettings['stealth'], number>> = { off: 0, standard: 1, max: 2 };

/** How `settings` falls short of `floor`; empty when the template meets it. */
export function stealthFloorIssues(
  settings: StealthSettings,
  floor: StrategyParams['stealth-profile'],
): StealthFloorIssue[] {
  const issues: StealthFloorIssue[] = [];
  if (LEVEL[settings.stealth] < LEVEL[floor.minLevel]) {
    issues.push({
      code: 'stealth_below_floor',
      message: `needs stealth '${floor.minLevel}' or higher (the template has '${settings.stealth}')`,
    });
  }
  if (floor.fingerprint === 'required' && !settings.fingerprint) {
    issues.push({ code: 'fingerprint_required', message: 'needs fingerprint noise on' });
  }
  if (floor.fingerprint === 'forbidden' && settings.fingerprint) {
    issues.push({
      code: 'fingerprint_forbidden',
      message: 'needs fingerprint noise off (the site flags canvas and audio noise)',
    });
  }
  return issues;
}

/** {@link stealthFloorIssues} for a pack (none when it does not select `stealth-profile`). */
export function packFloorIssues(settings: StealthSettings, pack: SitePackV1): StealthFloorIssue[] {
  const floor = strategyOf(pack, 'stealth-profile');
  return floor === null ? [] : stealthFloorIssues(settings, floor);
}
