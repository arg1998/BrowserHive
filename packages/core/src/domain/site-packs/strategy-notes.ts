/** @module domain/site-packs/strategy-notes — what a site's pack selects that a template or the machine cannot apply in full (spec 13 §9.4; deferred D49, D50): forced humanized input on a template with stealth `off` (input stays native; the runtime logs `humanize not forced`), and `single-focus` on a headless template on macOS or Windows (a clicked page keeps real focus: minimizing releases it on Linux only). Pure; the template page shows the notes on the site's card. */

import type { TemplateStrategyNote } from '@browserhive/contracts/http';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { strategyOf } from './strategy-params.ts';

/** The template settings the notes read. */
export interface StrategyNoteSettings {
  readonly stealth: 'off' | 'standard' | 'max';
  readonly headless: boolean;
}

/**
 * Whether a headless window's real focus can be released on `platform` (`process.platform`): only
 * minimizing does it, measured on Linux (it stalled on macOS and did not release on Windows, T3b).
 */
export function headlessFocusReleases(platform: string): boolean {
  return platform === 'linux';
}

/** Whether `pack` forces humanized input on its pages (`humanize-input`, or `stealth-profile.humanize`). */
export function packForcesHumanize(pack: SitePackV1): boolean {
  return (
    strategyOf(pack, 'humanize-input') !== null ||
    strategyOf(pack, 'stealth-profile')?.humanize === true
  );
}

/** The notes for a site whose pack in force is `pack`, on a template with `settings`, on `platform`. */
export function strategyNotesOf(
  pack: SitePackV1,
  settings: StrategyNoteSettings,
  platform: string,
): TemplateStrategyNote[] {
  const notes: TemplateStrategyNote[] = [];
  if (settings.stealth === 'off' && packForcesHumanize(pack)) {
    notes.push({
      code: 'humanize_needs_stealth',
      message:
        `The ${pack.title} site pack asks for humanized input (clicks and typing paced like a person), ` +
        'but this template has stealth off, so input on the site stays native and instant. ' +
        'Stealth is fixed for a template’s life: to humanize, create a template with stealth on ' +
        '(Standard or Max). Otherwise there is nothing to do: native input is what stealth off means.',
    });
  }
  if (
    settings.headless &&
    !headlessFocusReleases(platform) &&
    strategyOf(pack, 'single-focus') !== null
  ) {
    notes.push({
      code: 'single_focus_limited',
      message:
        `The ${pack.title} site pack keeps one of the site’s tabs in focus at a time. On a headless ` +
        'browser on macOS or Windows, a tab that once got a click keeps real focus, so the site ' +
        'can still see several focused tabs of one account. A headed template, or BrowserHive on ' +
        'Linux, applies it in full.',
    });
  }
  return notes;
}
