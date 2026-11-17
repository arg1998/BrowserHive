/** @module features/site-packs/detail/labels — words for a pack's data on its page (spec 13 §9.2–§9.5): guard kinds and actions, challenge kinds and providers, probe kinds, sources, browser and consistency values, pace periods, and the section names of `verified` */
import type { SitePackV1 } from '@browserhive/contracts/site-packs';

type Guard = SitePackV1['guards'][number];
type Challenge = SitePackV1['challenges'][number];

/** What a guard protects. */
export const GUARD_KIND_LABEL: { readonly [K in Guard['kind']]: string } = {
  logout: 'Sign-out',
  account: 'Account and security',
  credential: 'Credentials and keys',
  destructive: 'Destructive',
  write: 'Write',
};

/** What a matching guard does. */
export const GUARD_ACTION_LABEL: { readonly [K in Guard['action']]: string } = {
  block: 'Block',
  confirm: 'Ask first',
  warn: 'Flag',
  write_policy: 'Write policy',
};

/** A challenge kind. */
export const CHALLENGE_KIND_LABEL: { readonly [K in Challenge['kind']]: string } = {
  checkpoint: 'Checkpoint',
  captcha: 'Captcha',
  reauth: 'Sign in again',
  locked: 'Account locked',
  rejected: 'Sign-in refused',
};

/** What a challenge does. */
export const CHALLENGE_ACTION_LABEL: { readonly [K in Challenge['action']]: string } = {
  attention: 'Ask you to clear it',
  stop: 'Stop the site until you clear it',
};

/** How the signed-in check decides. */
export const PROBE_KIND_LABEL: { readonly [K in SitePackV1['signed_in']['kind']]: string } = {
  redirect: 'Signed out when the page redirects to sign-in',
  landmark: 'Signed in when a signed-in element shows',
  either: 'A redirect or a signed-in element',
};

/** A source's kind. */
export const SOURCE_KIND_LABEL: { readonly [K in SitePackV1['sources'][number]['kind']]: string } =
  {
    official: 'Official',
    vendor: 'Vendor guidance',
    community: 'Community',
    observed: 'Observed',
  };

/** A pace period. */
export const PER_LABEL: { readonly [K in 'minute' | 'hour' | 'day' | 'week']: string } = {
  minute: 'minute',
  hour: 'hour',
  day: 'day',
  week: 'week',
};

/** The `verified` sections in words. */
export const SECTION_LABEL: Readonly<Record<string, string>> = {
  sign_in: 'Sign-in',
  signed_in: 'Signed-in check',
  guards: 'Guards',
  element_guards: 'Guarded controls',
  write_policy: 'Write policy',
  challenges: 'Security checks',
  concurrency: 'Sessions at once',
  pacing: 'Pacing',
  browser: 'Browser',
  device_binding: 'Device binding',
  consistency: 'Consistency',
  strategies: 'Strategies',
};

/** `https://host/path` of a scoped URL. */
export function scopedUrl(url: { readonly host: string; readonly path: string }): string {
  return `https://${url.host}${url.path}`;
}
