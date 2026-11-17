/** @module infra/site-packs/guard-rules.test — the pack rule source of a template host: the owning pack's guards before `DEFAULT_GUARDS`, `write_policy` from the template site's override else the pack default, caching per content, policy and generation, a pack that does not compile, and the catalog. */

import { describe, expect, it } from 'bun:test';
import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { matchRequestGuard } from '../../domain/policies/request-guard.ts';
import { DEFAULT_GUARDS } from '../../domain/site-packs/default-guards.ts';
import { basePack } from '../../domain/site-packs/test-fixtures.ts';
import type { SiteWritePolicy } from '../../ports/persistence/enums.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';
import { GuardRuleCatalog, PackGuardRuleSource } from './guard-rules.ts';

function effective(input: SitePackV1Input, sha256 = 'a'.repeat(64)): EffectivePack {
  const pack = SitePackV1.parse(input);
  return {
    packId: pack.id,
    pack,
    version: pack.version,
    sha256,
    source: 'bundled',
    localOverride: false,
  };
}

function source(options: { override?: SiteWritePolicy | null; pack?: EffectivePack } = {}) {
  const state = {
    pack: options.pack ?? effective(basePack()),
    override: options.override ?? null,
    generation: 1,
    lookups: 0,
  };
  const lookup: SitePackLookup = {
    effectiveFor: (host) => {
      state.lookups += 1;
      return host.endsWith('linkedin.com') ? state.pack : null;
    },
    effectiveById: (id) => (id === state.pack.packId ? state.pack : null),
    get generation() {
      return state.generation;
    },
  };
  const catalog = new GuardRuleCatalog();
  const logger = createCollectingLogger();
  const rules = new PackGuardRuleSource({
    templateId: 'tp-aaaaaaaaaa',
    lookup,
    overrides: { overrideFor: () => state.override },
    catalog,
    logger,
  });
  return { rules, state, catalog, logger };
}

const match = (src: PackGuardRuleSource, url: string, method = 'GET', type = 'document') =>
  matchRequestGuard(src.rulesFor(url), { url, method, resourceType: type })?.rule ?? null;

describe('PackGuardRuleSource', () => {
  it('returns the owning pack’s guards (`<pack id>#<guard id>`) followed by DEFAULT_GUARDS', () => {
    const { rules } = source();
    const ids = rules.rulesFor('https://www.linkedin.com/feed/').rules.map((r) => r.id);
    expect(ids).toEqual([
      'linkedin.com#logout',
      'linkedin.com#settings-post',
      'linkedin.com#invite',
      ...DEFAULT_GUARDS.map((g) => `browserhive#${g.id}`),
    ]);
    expect(match(rules, 'https://www.linkedin.com/m/logout/')?.id).toBe('linkedin.com#logout');
  });

  it('a URL outside every pack (or not http) gets DEFAULT_GUARDS only', () => {
    const { rules } = source();
    const ids = (url: string) => rules.rulesFor(url).rules.map((r) => r.id);
    const defaults = DEFAULT_GUARDS.map((g) => `browserhive#${g.id}`);
    expect(ids('https://github.com/login/oauth/authorize')).toEqual(defaults);
    expect(ids('data:text/html,x')).toEqual(defaults);
    expect(match(rules, 'https://github.com/login/oauth/authorize', 'POST')?.id).toBe(
      'browserhive#github-oauth-approve',
    );
  });

  it.each([
    [null, 'confirm'],
    ['allow', 'allow'],
    ['warn', 'warn'],
    ['confirm', 'confirm'],
  ] as const)(
    'write_policy with override %p acts as %p (pack default confirm)',
    (override, action) => {
      const { rules } = source({ override });
      const rule = match(
        rules,
        'https://www.linkedin.com/voyager/api/invitations',
        'POST',
        'fetch',
      );
      expect(rule?.id).toBe('linkedin.com#invite');
      expect(rule?.action).toBe(action);
    },
  );

  it('the pack default applies without an override', () => {
    const input = basePack();
    input.write_policy = { default: 'warn', stance: 'restricted' };
    const { rules } = source({ pack: effective(input) });
    expect(match(rules, 'https://www.linkedin.com/voyager/api/invitations', 'POST')?.action).toBe(
      'warn',
    );
  });

  it('caches per (content, policy) and recompiles on a new generation or override', () => {
    const { rules, state } = source();
    const first = rules.rulesFor('https://www.linkedin.com/');
    expect(rules.rulesFor('https://www.linkedin.com/x')).toBe(first);
    state.override = 'allow';
    const allowed = rules.rulesFor('https://www.linkedin.com/');
    expect(allowed).not.toBe(first);
    state.override = null;
    expect(rules.rulesFor('https://www.linkedin.com/')).toBe(first);
    state.generation = 2;
    expect(rules.rulesFor('https://www.linkedin.com/')).not.toBe(first);
  });

  it('a pack whose guards do not compile contributes nothing, logged once, never throws', () => {
    const input = basePack();
    input.guards = [{ id: 'everything', kind: 'logout', match: { url: '*' }, action: 'block' }];
    const { rules, logger } = source({ pack: effective(input) });
    const defaults = DEFAULT_GUARDS.map((g) => `browserhive#${g.id}`);
    expect(rules.rulesFor('https://www.linkedin.com/').rules.map((r) => r.id)).toEqual(defaults);
    rules.rulesFor('https://www.linkedin.com/again');
    expect(logger.records.filter((r) => r.msg === 'pack guards skipped')).toHaveLength(1);
  });

  it('the catalog names every compiled rule and every default guard', () => {
    const { rules, catalog } = source();
    expect(catalog.describe('browserhive#msa-consent')).toMatchObject({
      packId: 'browserhive',
      guardId: 'msa-consent',
      guardKind: 'credential',
      siteTitle: 'Microsoft',
    });
    expect(catalog.describe('linkedin.com#invite')).toBeNull();
    rules.rulesFor('https://www.linkedin.com/');
    expect(catalog.describe('linkedin.com#invite')).toEqual({
      ruleId: 'linkedin.com#invite',
      packId: 'linkedin.com',
      guardId: 'invite',
      guardKind: 'write',
      siteTitle: 'LinkedIn',
    });
  });
});
