/** @module test/cli/sitepacks-classes.test — classifications and strategies in `browserhive sitepacks` (spec 13 §9.4, §9.7, §11.5, T3b): `diff` prints each field's class and the candidate's, `list` and `show` the pending versions' classification, `show` the strategies with their parameters from `GET /site-packs/strategies`, and `apply` refused below a template's stealth floor */

import { describe, expect, it } from 'bun:test';
import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import type { SitePackDiffResponse, SiteStrategiesResponse } from '@browserhive/contracts/http';
import {
  diffBody,
  fakePackServer,
  PACK_BODY,
  packView,
  pendingItem,
  problem,
  run,
  SHA_A,
  SHA_B,
  URL_FLAGS,
} from './sitepacks-fakes.ts';

const CLASSIFIED: SitePackDiffResponse = {
  ...diffBody(4, SHA_B),
  classification: 'loosening',
  changes: [
    { path: 'guards[logout]', from: { id: 'logout' }, to: null, class: 'loosening' },
    { path: 'browser.headed', from: 'any', to: 'required', class: 'restrictive' },
    { path: 'title', from: 'LinkedIn', to: 'LinkedIn 2', class: 'neutral' },
  ],
};

const STRATEGIES: SiteStrategiesResponse = {
  data: [
    {
      id: 'human-dwell',
      title: 'Human dwell time',
      description: 'Waits between actions.',
      kind: 'behaviour',
      hooks: ['before_action'],
      params: [
        {
          name: 'min_ms',
          type: 'integer',
          default: 600,
          default_from: null,
          fallback: null,
          min: 0,
          max: 10_000,
          values: null,
          safe_direction: 'up',
          safe_value: null,
        },
        {
          name: 'max_ms',
          type: 'integer',
          default: 2500,
          default_from: null,
          fallback: null,
          min: 0,
          max: 20_000,
          values: null,
          safe_direction: 'up',
          safe_value: null,
        },
      ],
    },
  ],
};

describe('sitepacks diff', () => {
  it('prints the candidate’s classification, each field’s class and the counts', async () => {
    const server = fakePackServer();
    server.routes = (method, path) =>
      method === 'GET' && path.includes('/diff?') ? [200, CLASSIFIED] : undefined;
    const result = await run(server, ['diff', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Classification: relaxes rules (loosening)');
    expect(result.stdout).toContain('guards[logout] [relaxes rules (loosening)]');
    expect(result.stdout).toContain('browser.headed [can stop the site (restrictive)]');
    expect(result.stdout).toContain('title [no rule change (neutral)]');
    expect(result.stdout).toContain('3 field(s) changed: 1 loosening, 1 restrictive, 1 neutral.');
  });
});

describe('sitepacks list and show', () => {
  const pending = { ...pendingItem(4), classification: 'restrictive' as const };
  it('list shows a pending version’s classification', async () => {
    const result = await run(fakePackServer(packView({ pending: [pending] })), [
      'list',
      ...URL_FLAGS,
    ]);
    expect(result.stdout).toContain('v4 (can stop the site)');
  });

  it('show prints the classification and the strategies with their parameters', async () => {
    const server = fakePackServer(packView({ pending: [pending] }));
    server.routes = (method, path) => {
      if (method === 'GET' && path === '/api/v1/site-packs/strategies') return [200, STRATEGIES];
      if (method === 'GET' && path === '/api/v1/site-packs/linkedin.com') {
        return [
          200,
          {
            view: server.view,
            pack: {
              ...PACK_BODY,
              strategies: [
                { id: 'human-dwell', params: { min_ms: 800, max_ms: 50_000 } },
                { id: 'single-focus', params: {} },
              ],
            },
            versions: [{ version: 3, sha256: SHA_A, source: 'bundled', state: 'approved' }],
          },
        ];
      }
      return undefined;
    };
    const result = await run(server, ['show', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('v4 (can stop the site)');
    expect(result.stdout).toContain('Strategies:');
    expect(result.stdout).toContain('human-dwell — Human dwell time (behaviour)');
    expect(result.stdout).toContain('min_ms 800 (default 600, 0–10000)');
    expect(result.stdout).toContain('max_ms 20000, asked 50000 (default 2500, 0–20000)');
    expect(result.stdout).toMatch(/single-focus\n\s+no parameters/);
  });
});

describe('sitepacks apply below the stealth floor', () => {
  it('prints the refusal naming the template and changes nothing', async () => {
    const server = fakePackServer();
    server.routes = (method, path) =>
      method === 'POST' && path.endsWith('/apply')
        ? [
            409,
            {
              ...(problem(
                409,
                'SITE_PACK_BELOW_FLOOR',
                renderMessage(ERROR_REGISTRY.SITE_PACK_BELOW_FLOOR.message, {
                  version: 4,
                  pack_id: 'linkedin.com',
                  templates_text:
                    "'sales' needs stealth 'max' or higher (the template has 'standard')",
                }),
              ) as object),
              hint: ERROR_REGISTRY.SITE_PACK_BELOW_FLOOR.hint,
            },
          ]
        : undefined;
    const result = await run(server, ['apply', 'linkedin.com', '--yes', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[SITE_PACK_BELOW_FLOOR]');
    expect(result.stderr).toContain("'sales' needs stealth 'max' or higher");
    // Stealth is fixed for a template's life (review #84 M3): the advice is the Sites tab or a
    // new template, never raising the template's stealth.
    expect(result.stderr).toContain('turn the site off on the named templates (their Sites tab)');
    expect(result.stderr).not.toMatch(/Raise|Settings/);
  });
});
