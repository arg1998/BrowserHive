/** @module features/templates/wizard/site-needs — what a chosen site's pack needs from the template's settings (spec 13 §9.4 `stealth-profile`, §11.1 `POST /templates` refusals), read from the pack's content: a stealth floor (`min_level`), fingerprint noise required or forbidden, a visible browser, stealth on for a site signed in by hand only, and (advisory: stealth off is not refused, input just stays native) stealth on for forced humanized input. Gives the chosen-site chips, the step 3 checklist with its one-click fixes, the step 3 problems that keep Next from a refusal, and the field each server issue code belongs to */
import type { StealthLevel } from '@browserhive/contracts/enums';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';

/** The pack content fields read here (`SitePackV1` fits). */
type PackContent = Pick<SitePackV1Input, 'strategies' | 'browser' | 'sign_in'>;

/** What one site needs; `null` fields need nothing. */
export interface SiteNeeds {
  readonly site: string;
  readonly title: string;
  /** The least stealth the site accepts. */
  readonly minStealth: 'standard' | 'max' | null;
  readonly fingerprint: 'required' | 'forbidden' | null;
  /** The site needs a visible (headed) browser. */
  readonly headed: boolean;
  /**
   * The pack forces humanized input (`humanize-input`, or `stealth-profile.humanize`). Stealth `off`
   * ignores it (input stays native) but is not refused: an advisory need, never a step 3 problem.
   */
  readonly humanize: boolean;
}

/** The settings the needs are checked against (the draft's, or the server default it falls back to). */
export interface NeedsSettings {
  readonly stealth: StealthLevel;
  readonly fingerprint: boolean;
  readonly headless: boolean;
}

/** A need the settings do not meet: the field to change and the value that meets it. */
export type UnmetNeed =
  | { readonly field: 'stealth'; readonly to: 'standard' | 'max'; readonly message: string }
  | { readonly field: 'fingerprint'; readonly to: boolean; readonly message: string }
  | { readonly field: 'headless'; readonly to: false; readonly message: string };

const LEVEL: { readonly [L in StealthLevel]: number } = { off: 0, standard: 1, max: 2 };

/**
 * The needs of `site` from its pack's content, or `null` when it needs nothing. Parameters read as
 * the server reads them: an unknown value is the default (`standard`, `any`).
 */
export function siteNeedsOf(site: string, title: string, pack: PackContent): SiteNeeds | null {
  const profile = pack.strategies?.find((s) => s.id === 'stealth-profile');
  const params = profile?.params ?? {};
  const fingerprint = params['fingerprint'];
  const humanOnly = pack.sign_in?.human_only === true;
  const humanize =
    pack.strategies?.some((s) => s.id === 'humanize-input') === true || params['humanize'] === true;
  const minStealth =
    profile === undefined
      ? humanOnly
        ? 'standard'
        : null
      : params['min_level'] === 'max'
        ? 'max'
        : 'standard';
  const needs: SiteNeeds = {
    site,
    title,
    minStealth,
    fingerprint:
      profile !== undefined && (fingerprint === 'required' || fingerprint === 'forbidden')
        ? fingerprint
        : null,
    headed: pack.browser?.headed === 'required',
    humanize,
  };
  return needs.minStealth === null && needs.fingerprint === null && !needs.headed && !humanize
    ? null
    : needs;
}

/**
 * Whether the humanized-input need gets its own row and chip: a stealth floor already asks for
 * stealth on (and blocks creation below it), so only a site without one needs the advisory.
 */
export function humanizeAdvisory(needs: SiteNeeds): boolean {
  return needs.humanize && needs.minStealth === null;
}

/** The advisory the settings leave unmet: humanized input with stealth off (the template is still created). */
export function humanizeUnmet(needs: SiteNeeds, s: NeedsSettings): UnmetNeed | null {
  return humanizeAdvisory(needs) && s.stealth === 'off'
    ? {
        field: 'stealth',
        to: 'standard',
        message: `${needs.title} asks for humanized input, which needs Hide automation on.`,
      }
    : null;
}

/** Short labels for a chosen-site card. */
export function needChips(needs: SiteNeeds): string[] {
  const out: string[] = [];
  if (needs.minStealth === 'max') out.push('Needs stealth Max');
  else if (needs.minStealth === 'standard') out.push('Needs stealth on');
  if (needs.fingerprint === 'required') out.push('Needs fingerprint on');
  if (needs.fingerprint === 'forbidden') out.push('Fingerprint noise must be off');
  if (needs.headed) out.push('Needs a visible browser');
  if (humanizeAdvisory(needs)) out.push('Humanized input needs stealth on');
  return out;
}

/** What `needs` asks of the settings and does not get. */
export function unmetNeeds(needs: SiteNeeds, s: NeedsSettings): UnmetNeed[] {
  const out: UnmetNeed[] = [];
  const t = needs.title;
  if (needs.minStealth !== null && LEVEL[s.stealth] < LEVEL[needs.minStealth]) {
    out.push({
      field: 'stealth',
      to: needs.minStealth,
      message:
        needs.minStealth === 'max'
          ? `${t} needs Hide automation set to Max.`
          : `${t} needs Hide automation on (Standard or Max).`,
    });
  }
  if (needs.fingerprint === 'required' && !s.fingerprint) {
    out.push({ field: 'fingerprint', to: true, message: `${t} needs Consistent fingerprint on.` });
  }
  if (needs.fingerprint === 'forbidden' && s.fingerprint) {
    out.push({
      field: 'fingerprint',
      to: false,
      message: `${t} flags fingerprint noise: turn Consistent fingerprint off.`,
    });
  }
  if (needs.headed && s.headless) {
    out.push({
      field: 'headless',
      to: false,
      message: `${t} needs a visible browser: turn headless off.`,
    });
  }
  return out;
}

/** Step 3 problems: the first unmet need per field, so Next explains instead of a refusal. */
export function needProblems(
  all: readonly SiteNeeds[],
  s: NeedsSettings,
): { readonly field: string; readonly message: string }[] {
  const seen = new Set<string>();
  return all
    .flatMap((n) => unmetNeeds(n, s))
    .filter((u) => !seen.has(u.field) && seen.add(u.field) !== undefined)
    .map((u) => ({ field: u.field, message: u.message }));
}

/** The step 3 field a server pack-requirement issue belongs to (`POST /templates` 400 codes). */
export const FIELD_OF_ISSUE_CODE: Readonly<Record<string, 'stealth' | 'fingerprint' | 'headless'>> =
  {
    stealth_below_floor: 'stealth',
    human_only_stealth_off: 'stealth',
    fingerprint_required: 'fingerprint',
    fingerprint_forbidden: 'fingerprint',
    headed_required: 'headless',
  };
