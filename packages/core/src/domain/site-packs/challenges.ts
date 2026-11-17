/** @module domain/site-packs/challenges — challenge matching (spec 13 §9.5): `CHALLENGE_PROVIDERS` by frame URL, the provider challenge paths, the visibility rule, `DEFAULT_CHALLENGES` and the first challenge a page matches. Pure: the page is read through {@link ChallengePageFacts}. */

import type {
  PackChallenge,
  PackChallengeKind,
  SitePackV1,
} from '@browserhive/contracts/site-packs';
import { assertNever } from '../../kernel/errors/app-error.ts';
import { matchesPackGlob } from './pack-glob.ts';

/** A provider BrowserHive recognises by frame (`PACK_CHALLENGE_PROVIDERS`). */
export type ChallengeProvider = NonNullable<PackChallenge['match']['frame']>;

/** The pack id compiled-in rules report (`DEFAULT_CHALLENGES`, `DEFAULT_GUARDS`). */
export const BUILTIN_PACK_ID = 'browserhive';

/** What a match does; `notify` is internal (packs cannot use it): health only, no request. */
export type ChallengeAction = 'attention' | 'stop' | 'notify';

/** One challenge rule as detection evaluates it (a pack's or a compiled-in one). */
export interface ChallengeRule {
  /** `BUILTIN_PACK_ID` for `DEFAULT_CHALLENGES`. */
  readonly packId: string;
  readonly id: string;
  readonly kind: PackChallengeKind;
  readonly action: ChallengeAction;
  readonly match: {
    readonly url?: string;
    readonly frame?: ChallengeProvider | 'any';
    /** Any of these in the main frame's title (case-insensitive). */
    readonly titles?: readonly string[];
    readonly landmark?: string;
    readonly text?: string;
  };
}

/**
 * The compiled-in challenges (spec 13 §9.5), applied on every host page: the Cloudflare
 * interstitial (`attention`) and any provider challenge surface (`notify`).
 */
export const DEFAULT_CHALLENGES: readonly ChallengeRule[] = Object.freeze([
  {
    packId: BUILTIN_PACK_ID,
    id: 'cloudflare-interstitial',
    kind: 'captcha',
    action: 'attention',
    match: { titles: ['Just a moment', 'Verify you are human'], frame: 'cloudflare' },
  },
  {
    packId: BUILTIN_PACK_ID,
    id: 'provider-surface',
    kind: 'captcha',
    action: 'notify',
    match: { frame: 'any' },
  },
]);

/** A pack's challenges as rules, in pack order. */
export function packChallengeRules(pack: SitePackV1): readonly ChallengeRule[] {
  return pack.challenges.map((c) => ({
    packId: pack.id,
    id: c.id,
    kind: c.kind,
    action: c.action,
    match: {
      ...(c.match.url !== undefined && { url: c.match.url }),
      ...(c.match.frame !== undefined && { frame: c.match.frame }),
      ...(c.match.title_contains !== undefined && { titles: [c.match.title_contains] }),
      ...(c.match.landmark !== undefined && { landmark: c.match.landmark }),
      ...(c.match.text !== undefined && { text: c.match.text }),
    },
  }));
}

/** The rules of a page: its pack's challenges first (when it has one), then `DEFAULT_CHALLENGES`. */
export function challengeRulesFor(pack: SitePackV1 | null): readonly ChallengeRule[] {
  return pack === null ? DEFAULT_CHALLENGES : [...packChallengeRules(pack), ...DEFAULT_CHALLENGES];
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The provider a frame URL belongs to (`CHALLENGE_PROVIDERS`), or `null`. */
export function providerOfFrameUrl(url: string): ChallengeProvider | null {
  const parsed = parse(url);
  if (parsed === null || parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (host === 'challenges.cloudflare.com') return 'cloudflare';
  if (
    (host === 'www.google.com' || host === 'www.recaptcha.net') &&
    parsed.pathname.startsWith('/recaptcha/')
  ) {
    return 'recaptcha';
  }
  if (under('hcaptcha.com')) return 'hcaptcha';
  if (host.endsWith('.arkoselabs.com')) return 'arkose';
  if (host.endsWith('.captcha-delivery.com')) return 'datadome';
  return null;
}

/**
 * A provider frame on a challenge path (spec 13 §9.5): reCAPTCHA's `bframe` (api2 and enterprise),
 * hCaptcha's challenge frame (`frame=challenge`), Arkose `enforcement`, DataDome's
 * `geo.captcha-delivery.com/captcha`. Cloudflare has none: its frames count by visibility only.
 */
export function isChallengePath(provider: ChallengeProvider, url: string): boolean {
  const parsed = parse(url);
  if (parsed === null) return false;
  const path = parsed.pathname.toLowerCase();
  switch (provider) {
    case 'recaptcha':
      return (
        path.startsWith('/recaptcha/api2/bframe') || path.startsWith('/recaptcha/enterprise/bframe')
      );
    case 'hcaptcha':
      return /(?:^|[#&?])frame=challenge(?:&|$)/.test(`${parsed.search}${parsed.hash}`);
    case 'arkose':
      return path.includes('enforcement');
    case 'datadome':
      return (
        parsed.hostname.toLowerCase() === 'geo.captcha-delivery.com' && path.startsWith('/captcha')
      );
    case 'cloudflare':
      return false;
    default:
      return assertNever(provider);
  }
}

/** A frame element's box in CSS pixels (Playwright's `boundingBox()`). */
export interface FrameBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Smallest provider frame that counts as a visible surface (spec 13 §9.5). */
export const SURFACE_MIN_WIDTH = 100;
/** Smallest provider frame height that counts as a visible surface. */
export const SURFACE_MIN_HEIGHT = 60;

/**
 * The visibility rule (spec 13 §9.5): the frame's element is visible, at least 100 × 60 CSS px
 * and intersects the viewport. Invisible and badge-only frames (reCAPTCHA v3 anchors with
 * `size=invisible`, Turnstile in invisible mode) fail it. `viewport` `null`: unknown, so only the
 * top-left quadrant bound applies (the box must reach into positive coordinates).
 */
export function isVisibleSurface(
  box: FrameBox | null,
  visible: boolean,
  viewport: { readonly width: number; readonly height: number } | null,
): boolean {
  if (!visible || box === null) return false;
  if (box.width < SURFACE_MIN_WIDTH || box.height < SURFACE_MIN_HEIGHT) return false;
  if (box.x + box.width <= 0 || box.y + box.height <= 0) return false;
  if (viewport === null) return true;
  return box.x < viewport.width && box.y < viewport.height;
}

/** What detection knows of a page; the async reads are only made for rules that need them. */
export interface ChallengePageFacts {
  /** The main frame's URL. */
  readonly url: string;
  /**
   * The main frame's URL is the one the agent itself passed to `navigate`/`new_tab`: a `url`
   * member never matches then (spec 13 §9.5, an agent can set no state by navigating).
   */
  readonly urlExempt: boolean;
  /** Providers with a challenge surface on the page now. */
  readonly surfaces: ReadonlySet<ChallengeProvider>;
  title(): Promise<string>;
  hasLandmark(selector: string): Promise<boolean>;
  hasText(text: string): Promise<boolean>;
}

/** Every present member of `rule` holds (members are ANDed; a rule has at least one). */
async function matches(rule: ChallengeRule, facts: ChallengePageFacts): Promise<boolean> {
  const m = rule.match;
  if (m.url !== undefined && (facts.urlExempt || !matchesPackGlob(m.url, facts.url))) return false;
  if (m.frame !== undefined) {
    if (m.frame === 'any' ? facts.surfaces.size === 0 : !facts.surfaces.has(m.frame)) return false;
  }
  if (m.titles !== undefined) {
    const title = (await facts.title()).toLowerCase();
    if (!m.titles.some((t) => title.includes(t.toLowerCase()))) return false;
  }
  if (m.landmark !== undefined && !(await facts.hasLandmark(m.landmark))) return false;
  if (m.text !== undefined && !(await facts.hasText(m.text))) return false;
  return (
    m.url !== undefined ||
    m.frame !== undefined ||
    m.titles !== undefined ||
    m.landmark !== undefined ||
    m.text !== undefined
  );
}

/** The first rule the page matches, in order, or `null`. A rule whose read throws is skipped. */
export async function firstChallenge(
  rules: readonly ChallengeRule[],
  facts: ChallengePageFacts,
): Promise<ChallengeRule | null> {
  for (const rule of rules) {
    try {
      if (await matches(rule, facts)) return rule;
    } catch {
      // Fail-open: a page that navigated away or a refused selector is no match.
    }
  }
  return null;
}

/** The probe and health reason of a challenge (`challenge:<kind>`, spec 13 §8.1). */
export function challengeReason(kind: PackChallengeKind): string {
  return `challenge:${kind}`;
}
