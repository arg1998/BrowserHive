/** @module features/templates/model — pure helpers of the templates pages: the remote-operator rule (spec 13 §3.11), site health, sign-in groups, names and counts */
import type { TemplateHealthState } from '@browserhive/contracts/enums';
import type { TemplateSiteView, TemplateSummary } from '@browserhive/contracts/http';
import type { IconName } from '@/lib/icons.ts';

const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `true` for a host name that can only be this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK.has(host) || host.startsWith('127.') || host.endsWith('.localhost');
}

/**
 * The machine the dashboard reaches BrowserHive at when that is not this device, else `null`
 * (spec 13 §3.11): a loopback address means the browser runs on the BrowserHive machine. The same
 * rule as the CLI's warning (`remoteHostName`).
 */
export function remoteHost(location: { readonly hostname: string }): string | null {
  if (location.hostname === '') return null;
  return isLoopbackHost(location.hostname) ? null : location.hostname;
}

/** Health states that need the operator to sign in again. */
export function needsSignIn(state: TemplateHealthState): boolean {
  return state === 'signed_out' || state === 'challenged';
}

/** The icon of a health state (shape as well as colour, WCAG 1.4.1). */
export const HEALTH_ICON: { readonly [K in TemplateHealthState]: IconName } = {
  signed_in: 'success',
  signed_out: 'failure',
  challenged: 'warn',
  inconclusive: 'help',
  unknown: 'notChecked',
};

/** Sites of a list row that need a sign-in. */
export function signInsNeeded(template: Pick<TemplateSummary, 'sites'>): number {
  return template.sites.filter((s) => needsSignIn(s.health_state)).length;
}

/**
 * Sites grouped by sign-in: sites that share one login (a pack's identity provider) sit in one card
 * (spec 13 §2.3). Without packs every site is its own group, named by its title.
 */
export function signInGroups(sites: readonly TemplateSiteView[]): readonly {
  readonly key: string;
  readonly title: string;
  readonly sites: readonly TemplateSiteView[];
}[] {
  return sites.map((site) => ({ key: site.site_id, title: site.title, sites: [site] }));
}

/** `2 / 5` sessions. */
export function capText(inUse: number, cap: number): string {
  return `${inUse} / ${cap}`;
}

/** Agent pages of a browser in words (`3 pages`, nothing when stopped). */
export function pagesText(state: string, pages: number): string | null {
  if (state === 'stopped' || state === 'failed') return null;
  return `${pages} ${pages === 1 ? 'page' : 'pages'}`;
}

/** The agent-facing name grammar (`TEMPLATE_NAME_RE`): 2–32 characters, a–z first, then a–z, 0–9 or -. */
export const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** What is wrong with a name, in words, or `null`. */
export function nameProblem(name: string): string | null {
  if (name.length === 0) return 'Give the template a name agents will use.';
  if (name.length < 2) return 'At least 2 characters.';
  if (name.length > 32) return 'At most 32 characters.';
  if (!/^[a-z]/.test(name)) return 'Start with a lowercase letter.';
  if (!NAME_RE.test(name)) return 'Use lowercase letters, digits and dashes only.';
  return null;
}

/** A name suggested from a display name (`Job hunt` → `job-hunt`), or `''`. */
export function suggestName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug.length >= 2 ? slug : '';
}

/** A domain as typed (`https://www.LinkedIn.com/jobs`) reduced to its host (`www.linkedin.com`), or `null`. */
export function hostOf(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (text.length === 0) return null;
  let host = text;
  try {
    host = new URL(text.includes('://') ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.startsWith('.')) return null;
  return host.replace(/^www\./, '');
}

/** A browser channel as people say it. */
export const CHANNEL_LABEL: { readonly [K in 'chromium' | 'chrome' | 'edge']: string } = {
  chromium: 'Chromium',
  chrome: 'Chrome',
  edge: 'Edge',
};

/** A security check's kind (`challenge:<kind>`, spec 13 §9.5) in words. */
const CHALLENGE_TEXT: Readonly<Record<string, string>> = {
  checkpoint: 'a checkpoint',
  captcha: 'a captcha',
  reauth: 'a request to sign in again',
  locked: 'a locked-account page',
  rejected: 'a refused sign-in',
};

/** A health reason code (spec 13 §8.1) in words; unknown codes are shown plainly. */
export function healthReasonText(reason: string | null): string | null {
  if (reason === null || reason === '') return null;
  if (reason.startsWith('challenge:')) {
    const kind = reason.slice('challenge:'.length);
    return `The site showed ${CHALLENGE_TEXT[kind] ?? 'a security check'}: clear it in the browser.`;
  }
  const http = /^http_(\d{3})$/.exec(reason);
  if (http !== null) return `The site answered with an error (HTTP ${http[1]}).`;
  const known: Readonly<Record<string, string>> = {
    confirmed_by_operator: 'You confirmed the sign-in.',
    detected_by_pack_cookies: 'Its sign-in cookies appeared while you signed in.',
    not_confirmed: 'Not confirmed when the sign-in finished.',
    relogin: 'Signed in again with Re-login.',
    cookies_absent: 'Its sign-in cookies are gone.',
    partial_cookies: 'Only some of its sign-in cookies are there.',
    learned_cookies: 'Its sign-in cookies are there.',
    no_pack:
      'BrowserHive hasn’t learned how this site signs in yet. Use Re-login, sign in, then press I’m signed in to teach it.',
    not_running: 'Couldn’t check: the browser isn’t running.',
    no_signal: 'Nothing showed whether you are signed in.',
    timeout: 'The check timed out.',
    network: 'The site could not be reached.',
    redirect: 'The site sent the check to its sign-in page.',
    marker: 'The page showed a signed-out sign.',
    landmark: 'The page showed the signed-in view.',
    no_redirect: 'The signed-in page opened without a detour to sign-in.',
    no_redirect_settled:
      'The signed-in page loaded and stayed put for a few seconds. A weaker sign: a site that signs you out later, or only shows a sign-in box, looks the same.',
  };
  return known[reason] ?? `${reason.replaceAll('_', ' ')}.`;
}

/** Inconclusive checks in a row before the page warns (spec 13 §8.3). */
export const INCONCLUSIVE_WARN_AFTER = 3;

/** "BrowserHive couldn't tell whether LinkedIn is signed in", or `null` below the threshold. */
export function inconclusiveWarning(
  site: Pick<TemplateSiteView, 'title' | 'health'>,
): string | null {
  // `no_pack`: nothing learned yet; the reason already says what to do.
  return site.health.consecutive_inconclusive >= INCONCLUSIVE_WARN_AFTER &&
    site.health.reason !== 'no_pack'
    ? `BrowserHive couldn’t tell whether ${site.title} is signed in`
    : null;
}

/** Whether `host` (a page's host name) is one of `sites` or under one of them (`www.linkedin.com`). */
export function hostOnSites(host: string, sites: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return sites.some((site) => h === site || h.endsWith(`.${site}`));
}

/** A Check now the 2-minute cap cut short (review #81 L-4): what was not checked keeps its result. */
export const CUT_SHORT =
  'Sites without a result weren’t checked; their last result stands. Check again later.';
