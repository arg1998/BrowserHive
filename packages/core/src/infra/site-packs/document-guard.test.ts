/** @module infra/site-packs/document-guard.test — the tool path's `GET` document guard (spec 13 §9.3) over the host's own rule source: the guard grammar (query strings, paths beneath, unreserved escapes, case), method and resource type, `write_policy` resolved from the template site's override else the pack default, and `DEFAULT_GUARDS` as `browserhive#<id>` with or without a pack. */

import { describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import { DEFAULT_GUARDS } from '../../domain/site-packs/default-guards.ts';
import { basePack } from '../../domain/site-packs/test-fixtures.ts';
import type { SiteWritePolicy } from '../../ports/persistence/enums.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { documentGuardResolver } from './document-guard.ts';
import { GuardRuleCatalog } from './guard-rules.ts';

const pack = SitePackV1.parse({
  ...basePack(),
  guards: [
    ...(basePack().guards ?? []),
    {
      id: 'delete-get',
      kind: 'write',
      match: { url: 'www.linkedin.com/delete', methods: ['GET'] },
      action: 'write_policy',
    },
    {
      id: 'help-post',
      kind: 'account',
      match: { url: 'www.linkedin.com/help', methods: ['POST'] },
      action: 'block',
    },
    {
      id: 'api-xhr',
      kind: 'account',
      match: { url: 'www.linkedin.com/api/*', resource_types: ['xhr'] },
      action: 'block',
    },
  ],
});
const effective: EffectivePack = {
  packId: pack.id,
  pack,
  version: pack.version,
  sha256: 'a'.repeat(64),
  source: 'bundled',
  localOverride: false,
};
const lookup: SitePackLookup = {
  effectiveFor: (host) => (host.endsWith('linkedin.com') ? effective : null),
  effectiveById: (id) => (id === pack.id ? effective : null),
  generation: 1,
};

function resolver(override: SiteWritePolicy | null = null) {
  return documentGuardResolver({
    lookup,
    overrides: { overrideFor: () => override },
    catalog: new GuardRuleCatalog(),
    logger: createCollectingLogger(),
  });
}

describe('documentGuardResolver', () => {
  it.each([
    ['https://www.linkedin.com/m/logout', 'linkedin.com#logout'],
    ['https://www.linkedin.com/m/logout/', 'linkedin.com#logout'],
    ['https://www.linkedin.com/m/logout?next=/', 'linkedin.com#logout'],
    ['https://www.linkedin.com/m/log%6Fut', 'linkedin.com#logout'],
    ['https://WWW.LinkedIn.com/m/logout', 'linkedin.com#logout'],
    ['https://www.linkedin.com/m/logout-help', null],
    ['https://www.linkedin.com/help', null],
    ['https://www.linkedin.com/api/x', null],
    ['https://www.linkedin.com/feed/', null],
  ])('%s → %s', (url, ruleId) => {
    expect(resolver()('tp-1', url)?.ruleId ?? null).toBe(ruleId);
  });

  it('resolves write_policy from the template override, else the pack default', () => {
    const url = 'https://www.linkedin.com/delete';
    expect(resolver()('tp-1', url)).toEqual({
      ruleId: 'linkedin.com#delete-get',
      packId: 'linkedin.com',
      guardId: 'delete-get',
      kind: 'write',
      action: 'confirm',
    });
    expect(resolver('warn')('tp-1', url)?.action).toBe('warn');
    expect(resolver('allow')('tp-1', url)?.action).toBe('allow');
  });

  it('applies DEFAULT_GUARDS as browserhive#<id> on any site', () => {
    const guard = DEFAULT_GUARDS[0];
    if (guard === undefined) throw new Error('no default guard');
    const url = `https://${guard.url.replace(/\*$/, 'x')}`;
    expect(resolver()('tp-1', url)).toMatchObject({
      ruleId: `browserhive#${guard.id}`,
      packId: 'browserhive',
      kind: guard.kind,
      action: 'block',
    });
    expect(resolver()('tp-1', 'about:blank')).toBeNull();
  });
});
