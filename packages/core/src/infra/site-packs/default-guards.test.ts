/** @module infra/site-packs/default-guards.test — `DEFAULT_GUARDS` compile in order, block the verified consent endpoints, and leave sign-in pages and GitHub's silent authorize redirect alone. */

import { describe, expect, it } from 'bun:test';
import {
  compileRequestGuardRules,
  matchRequestGuard,
} from '../../domain/policies/request-guard.ts';
import { DEFAULT_GUARDS, defaultGuardRuleId } from '../../domain/site-packs/default-guards.ts';
import { defaultGuardRuleInputs } from './guard-rules.ts';

function compiled() {
  const result = compileRequestGuardRules(defaultGuardRuleInputs());
  if (!result.ok) throw new Error(`does not compile: ${JSON.stringify(result.error)}`);
  return result.value;
}

function ruleFor(url: string, method = 'POST', resourceType = 'document'): string | null {
  return matchRequestGuard(compiled(), { url, method, resourceType })?.rule.id ?? null;
}

describe('DEFAULT_GUARDS', () => {
  it('compiles, every entry a credential block with a browserhive# rule id, in order', () => {
    const rules = compiled().rules;
    expect(rules.map((r) => r.id)).toEqual(DEFAULT_GUARDS.map((g) => defaultGuardRuleId(g.id)));
    expect(rules.every((r) => r.id.startsWith('browserhive#') && r.action === 'block')).toBe(true);
    expect(DEFAULT_GUARDS.every((g) => g.kind === 'credential')).toBe(true);
  });

  it.each([
    [
      'https://accounts.google.com/signin/oauth/v3/consent?authuser=0',
      'GET',
      'google-oauth-consent',
    ],
    ['https://accounts.google.com/signin/oauth/consent/approve', 'POST', 'google-oauth-consent'],
    ['https://github.com/login/oauth/authorize', 'POST', 'github-oauth-approve'],
    ['https://github.com/login/oauth/authorize?client_id=x', 'POST', 'github-oauth-approve'],
    ['https://github.com/login/device/authorize', 'POST', 'github-device-approve'],
    [
      'https://login.microsoftonline.com/common/v2.0/adminconsent?client_id=x',
      'GET',
      'entra-admin-consent',
    ],
    ['https://login.microsoftonline.com/contoso.com/adminconsent', 'POST', 'entra-admin-consent'],
    ['https://account.live.com/consent/Update', 'POST', 'msa-consent'],
    ['https://account.live.com/Consent/Manage', 'GET', 'msa-consent'],
  ])('%s (%s) is blocked by %s', (url, method, id) => {
    expect(ruleFor(url, method)).toBe(defaultGuardRuleId(id));
  });

  it.each([
    // An already-authorized app's silent redirect must keep working.
    ['https://github.com/login/oauth/authorize?client_id=x&scope=repo', 'GET'],
    ['https://github.com/login/device', 'GET'],
    // Signing in to Google is not consenting.
    ['https://accounts.google.com/v3/signin/identifier?continue=x', 'GET'],
    ['https://accounts.google.com/v3/signin/identifier', 'POST'],
    ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x', 'GET'],
    ['https://account.live.com/consentx', 'POST'],
  ])('%s (%s) is not matched', (url, method) => {
    expect(ruleFor(url, method)).toBeNull();
  });

  it('covers every resource type: an <img> or a prefetch of a consent URL is blocked too (M2)', () => {
    for (const type of ['image', 'other', 'script', 'stylesheet']) {
      expect(ruleFor('https://accounts.google.com/signin/oauth/v3/consent', 'GET', type)).toBe(
        defaultGuardRuleId('google-oauth-consent'),
      );
    }
  });

  it('the consent globs span the query string, failing closed (review S-L8, pinned)', () => {
    // `*consent*` also matches a consent page reached with `prompt=consent` in the query, and an
    // `adminconsent` anywhere after the host; the sign-in identifier step is never matched.
    expect(ruleFor('https://accounts.google.com/signin/oauth/v2/x?prompt=consent', 'GET')).toBe(
      defaultGuardRuleId('google-oauth-consent'),
    );
    expect(
      ruleFor('https://login.microsoftonline.com/common/oauth2/authorize?adminconsent=1', 'GET'),
    ).toBe(defaultGuardRuleId('entra-admin-consent'));
    expect(
      ruleFor('https://accounts.google.com/v3/signin/identifier?prompt=consent', 'GET'),
    ).toBeNull();
  });
});
