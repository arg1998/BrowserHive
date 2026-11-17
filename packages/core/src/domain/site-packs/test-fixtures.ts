/** @module domain/site-packs/test-fixtures — a valid LinkedIn-shaped pack for unit tests of the pack domain, the registry and enforcement. */

import type { SitePackV1Input } from '@browserhive/contracts/site-packs';

/** A valid LinkedIn-shaped pack. */
export function basePack(): SitePackV1Input {
  return {
    schema: 1,
    id: 'linkedin.com',
    version: 3,
    min_client: '0.3.0',
    title: 'LinkedIn',
    domains: ['linkedin.com', 'licdn.com'],
    sign_in: { url: { host: 'www.linkedin.com', path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: 'www.linkedin.com', path: '/feed/' },
      kind: 'redirect',
      signed_out_redirects: ['www.linkedin.com/uas/login*', 'www.linkedin.com/authwall*'],
    },
    guards: [
      {
        id: 'logout',
        kind: 'logout',
        match: { url: 'www.linkedin.com/m/logout' },
        action: 'block',
      },
      {
        id: 'settings-post',
        kind: 'account',
        match: { url: 'www.linkedin.com/mypreferences/*', methods: ['POST'] },
        action: 'block',
      },
      {
        id: 'invite',
        kind: 'write',
        match: { url: 'www.linkedin.com/voyager/api/invitations*', methods: ['POST'] },
        action: 'write_policy',
      },
    ],
    element_guards: [
      {
        id: 'signout-button',
        kind: 'logout',
        page: 'www.linkedin.com/*',
        target: { selector: 'a[href*="/m/logout"]' },
        action: 'block',
        request_guard: 'logout',
      },
    ],
    write_policy: { default: 'confirm', stance: 'prohibited' },
    challenges: [
      {
        id: 'checkpoint',
        kind: 'checkpoint',
        match: { url: 'www.linkedin.com/checkpoint/*' },
        action: 'attention',
      },
    ],
    pacing: {
      rules: [
        {
          id: 'invites',
          guard: 'invite',
          per: 'week',
          limit: 100,
          kind: 'vendor',
          source: { url: 'https://example.org/guidance', kind: 'vendor' },
        },
      ],
    },
  };
}
