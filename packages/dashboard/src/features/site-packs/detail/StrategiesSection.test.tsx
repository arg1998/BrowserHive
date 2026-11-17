/** @module features/site-packs/detail/StrategiesSection.test — a pack's strategies on `/site-packs/$id` (spec 13 §9.4, §11.4, T3b): titles, kinds and descriptions from `GET /site-packs/strategies`, each parameter's value in force (the pack's, clamped to the binary's bounds, else the default or the pack field it defaults from), its default, bounds and which way is stricter; a strategy this BrowserHive does not know; axe clean */

import { describe, expect, it } from 'bun:test';
import type { SiteStrategyParam } from '@browserhive/contracts/http';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  packContent,
  packDetail,
  packView,
  strategiesResponse,
} from '../../../../test/fixtures/site-packs.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { screen, within } from '../../../../test/helpers/render.tsx';
import { SitePackPage } from './SitePackPage.tsx';
import { directionText, paramRow, paramRows } from './strategy-model.ts';

const AXE = { disable: ['aria-hidden-focus'] } as const;

const PACK = packContent({
  pacing: { rules: [], min_launch_gap_s: 45 },
  strategies: [
    { id: 'human-dwell', params: { min_ms: 800, max_ms: 50_000 } },
    { id: 'launch-spacing', params: {} },
    { id: 'webrtc-policy', params: {} },
    { id: 'single-focus', params: {} },
    { id: 'entry-warmup', params: { path: '/jobs/' } },
  ],
});

function param(p: Partial<SiteStrategyParam> & Pick<SiteStrategyParam, 'name' | 'type'>) {
  return {
    default: null,
    default_from: null,
    fallback: null,
    min: null,
    min_from: null,
    max: null,
    values: null,
    safe_direction: 'up' as const,
    safe_value: null,
    ...p,
  };
}

describe('strategy-model', () => {
  const pack = SitePackV1.parse(PACK);
  it('clamps a number to the bounds and says what was asked', () => {
    const row = paramRow(
      param({
        name: 'max_ms',
        type: 'integer',
        default: 2500,
        min: 0,
        min_from: 'min_ms',
        max: 20_000,
      }),
      50_000,
      pack,
    );
    expect(row).toMatchObject({
      value: '20000',
      origin: 'clamped',
      raw: '50000',
      bounds: 'min_ms–20000',
    });
  });

  it('takes the lower bound from the parameter min_from names (max_ms ≥ min_ms, review #84 L3)', () => {
    const params = [
      param({ name: 'min_ms', type: 'integer', default: 600, min: 0, max: 10_000 }),
      param({
        name: 'max_ms',
        type: 'integer',
        default: 2500,
        min: 0,
        min_from: 'min_ms',
        max: 20_000,
      }),
    ];
    const [, max] = paramRows(params, { min_ms: 800, max_ms: 500 }, pack);
    expect(max).toMatchObject({
      value: '800',
      origin: 'clamped',
      raw: '500',
      bounds: 'min_ms–20000',
    });
    const [, inside] = paramRows(params, { min_ms: 800, max_ms: 900 }, pack);
    expect(inside).toMatchObject({ value: '900', origin: 'set', bounds: 'min_ms–20000' });
  });

  it('reads a default from the pack field it names, else the fallback', () => {
    const gap = param({
      name: 'min_gap_s',
      type: 'integer',
      default_from: 'pacing.min_launch_gap_s',
      fallback: 0,
      min: 0,
      max: 3600,
    });
    expect(paramRow(gap, undefined, pack)).toMatchObject({ value: '45', origin: 'pack' });
    const bare = SitePackV1.parse(packContent({ pacing: undefined }));
    expect(paramRow(gap, undefined, bare)).toMatchObject({ value: '0', origin: 'default' });
  });

  it('says which way is stricter', () => {
    expect(directionText(param({ name: 'a', type: 'integer' }))).toBe('Higher is stricter');
    expect(directionText(param({ name: 'a', type: 'boolean' }))).toBe('Turning it on is stricter');
    expect(directionText(param({ name: 'a', type: 'integer', safe_direction: 'down' }))).toBe(
      'Lower is stricter',
    );
    expect(
      directionText(param({ name: 'a', type: 'enum', safe_direction: 'away', safe_value: 'any' })),
    ).toBe('Stricter away from any');
    expect(directionText(param({ name: 'a', type: 'path', safe_direction: 'none' }))).toBe(
      'Any change relaxes rules',
    );
  });
});

describe('StrategiesSection', () => {
  it('shows each strategy as readable text with its parameters; axe clean', async () => {
    const view = renderPage({
      path: '/site-packs/$id',
      component: SitePackPage,
      routes: {
        'GET /site-packs/linkedin.com': packDetail(packView(), { pack: SitePackV1.parse(PACK) }),
        'GET /site-packs/strategies': strategiesResponse(),
        'GET /site-packs/changes': envelope([]),
      },
      url: '/site-packs/linkedin.com',
    });
    const section = await screen.findByRole('list', { name: 'Strategies' });
    expect(
      within(section).getByRole('heading', { level: 3, name: 'Human dwell time' }),
    ).toBeDefined();
    expect(within(section).getAllByText('Behaviour').length).toBe(2);
    expect(within(section).getAllByText('Stealth').length).toBe(2);
    const dwell = within(section).getByRole('list', { name: 'Human dwell time parameters' });
    expect(within(dwell).getByText('800')).toBeDefined();
    expect(within(dwell).getByText('20000')).toBeDefined();
    expect(within(dwell).getByText('the pack asks for 50000; kept within bounds')).toBeDefined();
    expect(within(dwell).getByText(/Allowed min_ms–20000/)).toBeDefined();
    const spacing = within(section).getByRole('list', { name: 'Space launches parameters' });
    expect(within(spacing).getByText('45')).toBeDefined();
    expect(within(spacing).getByText('from the pack’s settings')).toBeDefined();
    expect(
      within(spacing).getByText(/Default pacing\.min_launch_gap_s, else 0 · Allowed 0–3600/),
    ).toBeDefined();
    const webrtc = within(section).getByRole('list', { name: 'WebRTC address policy parameters' });
    expect(within(webrtc).getByText(/Stricter toward disable_non_proxied_udp/)).toBeDefined();
    expect(within(section).getByText('No parameters.')).toBeDefined();
    // Not in this fixture's table: shown by id, flagged.
    expect(within(section).getByText('Not known to this BrowserHive')).toBeDefined();
    await expectNoA11yViolations(view.container, AXE);
  });
});
