/** @module app/templates/views-agent.test — the `list_templates` entry (spec 13 §5.1) from the workload test's agent notes (D62): how long ago each site was checked, and a hint of what a template is for when the operator wrote no description. */

import { describe, expect, it } from 'bun:test';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { NO_PACKS } from './template-packs.ts';
import { toAgentTemplate } from './views.ts';

const NOW = 1_700_000_600_000;

function checkedAt(at: number) {
  return {
    state: 'signed_in' as const,
    reason: 'learned_cookies',
    checkedAt: at,
    changedAt: at,
    consecutiveInconclusive: 0,
  };
}

describe('toAgentTemplate (D62)', () => {
  it('says how many seconds ago each site was checked; never checked is null', () => {
    const entry = toAgentTemplate(
      templateRecord({ description: 'Job search' }),
      [
        templateSiteRecord({ siteId: 'site-a.test', health: checkedAt(NOW - 90_400) }),
        templateSiteRecord({ siteId: 'site-b.test' }),
        templateSiteRecord({ siteId: 'site-c.test', health: checkedAt(NOW + 5_000) }),
      ],
      'available',
      true,
      NO_PACKS,
      NOW,
    );
    expect(entry.sites.map((s) => [s.site, s.checked_ago_s])).toEqual([
      ['site-a.test', 90],
      ['site-b.test', null],
      // A clock that stepped back never reads as a negative age.
      ['site-c.test', 0],
    ]);
    expect(entry.description).toBe('Job search');
  });

  it('a template without a description names the sites it starts signed in to', () => {
    const sites = ['site-a.test', 'site-b.test', 'site-c.test'].map((siteId) =>
      templateSiteRecord({ siteId }),
    );
    const one = toAgentTemplate(
      templateRecord({ description: '  ' }),
      sites.slice(0, 1),
      'available',
      true,
      NO_PACKS,
      NOW,
    );
    expect(one.description).toBe('Starts signed in to site-a.test.');
    const three = toAgentTemplate(
      templateRecord({ description: '' }),
      sites,
      'available',
      true,
      NO_PACKS,
      NOW,
    );
    expect(three.description).toBe('Starts signed in to site-a.test, site-b.test and site-c.test.');
  });
});
