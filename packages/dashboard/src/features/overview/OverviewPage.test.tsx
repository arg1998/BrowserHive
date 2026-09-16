/** @module features/overview/OverviewPage.test — chart maths (nice scale, axis labels, bucket wording), tile grid, links (domains, failures, chart buckets), tiles from the fake API, live `system.capacity` patch, time-range URL rules, degradations callout, axe clean */

import { describe, expect, it } from 'bun:test';
import { stripSearchParams } from '@tanstack/react-router';
import { ServerClock, ServerClockContext } from '@/lib/server-now.ts';
import { activity, NOW, pageRow, systemInfo } from '../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { bucketFor, resolveWindow, takeWindowAnchor, WINDOW_ANCHOR_TTL_MS } from './api.ts';
import { lastSpanWording } from './components/ActivityCard.tsx';
import { sessionsWindowHref } from './components/ActivityChart.tsx';
import {
  axisLabels,
  bucketWording,
  niceScale,
  sparseActivitySpan,
  toPoints,
} from './components/activity-points.ts';
import { failureHref } from './components/FailuresCard.tsx';
import {
  errorSub,
  showBlockedTile,
  sparkPoints,
  tileGridClass,
} from './components/OverviewTiles.tsx';
import { domainHref, OverviewPage } from './OverviewPage.tsx';
import { OVERVIEW_DEFAULTS, overviewSearch } from './search.ts';

const routes = (system = systemInfo()) => ({
  'GET /activity': activity(),
  'GET /system': system,
  'GET /pages/recent': { data: [pageRow(1)], now: NOW },
  'GET /pages/domains': {
    data: [{ domain: 'example1.com', count: 3 }],
    window: { since: null, until: null },
    now: NOW,
  },
  'GET /sessions': envelope([]),
  'GET /tool-calls': envelope([
    {
      event_id: 'e-01HZX000000000000000000099',
      session_id: 'shop-a1b2c3d4',
      session_slug: 'shop',
      tool: 'click',
      tab_id: null,
      ok: false,
      error_code: 'ELEMENT_NOT_ACTIONABLE',
      error_message: 'Element did not become actionable',
      duration_ms: 30_000,
      result_size_bytes: 0,
      ts: NOW - 60_000,
      trace_id: null,
      has_screenshot: false,
    },
  ]),
});

function mount(url = '/overview', system = systemInfo()) {
  return renderPage({
    path: '/overview',
    component: OverviewPage,
    validateSearch: (s) => overviewSearch.parse(s),
    routes: routes(system),
    url,
  });
}

function tile(label: string): HTMLElement {
  const node = screen.getByText(label).closest('.rounded-xl');
  if (!(node instanceof HTMLElement)) throw new Error(`tile ${label} not found`);
  return node;
}

describe('overview helpers', () => {
  it('formats the error sub and picks custom bucket sizes', () => {
    expect(errorSub(2, 40, 30)).toBe('5% of calls · 30 all-time');
    expect(errorSub(0, 0, 0)).toBe('0% of calls');
    expect(bucketFor(3_600_000)).toBe(60_000);
    expect(bucketFor(30 * 86_400_000)).toBe(6 * 3_600_000);
  });

  it('parses the range vocabulary, corrects invalid values and strips defaults', () => {
    expect(overviewSearch.parse({})).toEqual({ range: '7d' });
    expect(overviewSearch.parse({ range: '168h', chart: 'collapsed' })).toEqual({ range: '7d' });
    expect(overviewSearch.parse({ range: 'all', since: '5' })).toMatchObject({
      range: 'all',
      since: 5,
    });
    const strip = stripSearchParams(OVERVIEW_DEFAULTS);
    expect(strip({ search: { range: '7d' }, next: (s) => s })).toEqual({});
  });
});

describe('window anchor', () => {
  it('keeps one anchor across remounts within the TTL and never ties keys to the ticking clock', () => {
    const t0 = 1_800_000_030_000;
    const anchor = takeWindowAnchor(t0, true);
    expect(anchor).toBe(1_800_000_000_000);
    expect(takeWindowAnchor(t0 + 61_000)).toBe(anchor);
    expect(takeWindowAnchor(t0 + WINDOW_ANCHOR_TTL_MS + 1)).toBeGreaterThan(anchor);
    // A clock behind the shared anchor (corrected server time) takes a fresh one, never a future anchor.
    expect(takeWindowAnchor(t0 - 86_400_000)).toBe(1_799_913_600_000);
    const week = resolveWindow('7d', undefined, undefined, anchor);
    expect(week).toEqual({
      range: '7d',
      since: anchor - 7 * 86_400_000,
      bucketMs: 6 * 3_600_000,
      label: '7d',
    });
    // Trailing windows are open-ended so live rows stay inside them.
    expect(week.until).toBeUndefined();
    expect(resolveWindow('all', undefined, undefined, anchor)).toMatchObject({ range: 'all' });
  });
});

describe('activity chart maths', () => {
  it('picks nice y-axis maxima with integer steps', () => {
    expect(niceScale(108, 5)).toEqual({ max: 125, ticks: [0, 25, 50, 75, 100, 125] });
    expect(niceScale(70, 4)).toEqual({ max: 80, ticks: [0, 20, 40, 60, 80] });
    expect(niceScale(3, 4)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(12, 4)).toEqual({ max: 15, ticks: [0, 5, 10, 15] });
    expect(niceScale(0)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    expect(niceScale(1000, 4).max).toBeGreaterThanOrEqual(1000);
    expect(niceScale(1000, 4).max).toBeLessThanOrEqual(1250);
  });

  it('labels sub-day buckets at day starts and thins crowded labels', () => {
    const day = 86_400_000;
    const start = new Date(2026, 8, 9, 2, 0).getTime();
    const sixHours = Array.from({ length: 28 }, (_, i) => ({ ts: start + i * 6 * 3_600_000 }));
    const labels = axisLabels(sixHours, 6 * 3_600_000);
    expect(labels.map((l) => l.text)).toEqual([
      'Sep 9',
      'Sep 10',
      'Sep 11',
      'Sep 12',
      'Sep 13',
      'Sep 14',
      'Sep 15',
    ]);
    expect(labels.map((l) => l.index)).toEqual([0, 4, 8, 12, 16, 20, 24]);
    // Each day label spans (and is centred over) that day's buckets.
    expect(labels.map((l) => l.span)).toEqual([4, 4, 4, 4, 4, 4, 4]);
    // A day with less than half of it in the window is not labelled.
    const late = new Date(2026, 8, 9, 20, 0).getTime();
    const shifted = Array.from({ length: 9 }, (_, i) => ({ ts: late + i * 6 * 3_600_000 }));
    expect(axisLabels(shifted, 6 * 3_600_000).map((l) => [l.text, l.span])).toEqual([
      ['Sep 10', 4],
      ['Sep 11', 4],
    ]);
    const hourly = Array.from({ length: 24 }, (_, i) => ({ ts: start + i * 3_600_000 }));
    const clock = axisLabels(hourly, 3_600_000);
    expect(clock.length).toBeLessThanOrEqual(8);
    expect(clock[0]?.text).toBe('02:00');
    const daily = Array.from({ length: 30 }, (_, i) => ({ ts: start + i * day }));
    expect(axisLabels(daily, day).length).toBeLessThanOrEqual(8);
    expect(axisLabels([], day)).toEqual([]);
  });

  it('words bucket sizes and builds bucket links', () => {
    expect(bucketWording(6 * 3_600_000)).toBe('6 hours');
    expect(bucketWording(3_600_000)).toBe('hour');
    expect(bucketWording(86_400_000)).toBe('day');
    expect(bucketWording(300_000)).toBe('5 minutes');
    expect(sessionsWindowHref({ ts: 10, end: 20 })).toBe('/sessions?since=10&until=20');
  });

  it('offers a zoom only when all activity sits in the last day of a wide window', () => {
    const bucketMs = 6 * 3_600_000;
    const quiet = Array.from({ length: 28 }, (_, i) => ({
      ts: i * bucketMs,
      tool_calls: i === 27 ? 300 : 0,
      errors: 0,
      sessions_started: i === 27 ? 1 : 0,
      sessions_closed: 0,
      blocked: 0,
      attention: 0,
    }));
    expect(sparseActivitySpan(toPoints(quiet, bucketMs))).toBe(bucketMs);
    expect(lastSpanWording(bucketMs)).toBe('the last 6 hours');
    const busy = quiet.map((b, i) => ({ ...b, tool_calls: i % 2 === 0 ? 4 : 0 }));
    expect(sparseActivitySpan(toPoints(busy, bucketMs))).toBeNull();
  });

  it('keeps trends only when they read as trends and hides an unused blocklist tile', () => {
    expect(sparkPoints([0, 0, 0, 9])).toBeUndefined();
    expect(sparkPoints([1, 0, 2, 9])).toEqual([1, 0, 2, 9]);
    const off = systemInfo({ blocklist: { configured: false, path: null, patterns: 0 } });
    expect(showBlockedTile(off, 0)).toBe(false);
    expect(showBlockedTile(off, 3)).toBe(true);
    expect(
      showBlockedTile(
        systemInfo({ blocklist: { configured: true, path: '/b.txt', patterns: 2 } }),
        0,
      ),
    ).toBe(true);
  });

  it('never orphans a tile and deep-links domains and failures', () => {
    expect(tileGridClass(6)).toBe('grid-cols-2 md:grid-cols-3 xl:grid-cols-6');
    expect(tileGridClass(8)).toBe('grid-cols-2 md:grid-cols-4');
    // Odd counts: the first tile spans two columns until all fit on one row.
    expect(tileGridClass(5)).toContain('[&>:first-child]:col-span-2');
    expect(tileGridClass(5)).toContain('xl:grid-cols-5');
    expect(tileGridClass(7)).toContain('[&>:first-child]:col-span-2');
    expect(domainHref('a.example', { range: '7d', since: undefined, until: undefined })).toBe(
      '/websites?domain=a.example',
    );
    expect(domainHref('a.example', { range: '24h', since: undefined, until: undefined })).toBe(
      '/websites?domain=a.example&range=24h',
    );
    expect(failureHref('shop-a1b2c3d4')).toBe('/sessions/shop-a1b2c3d4?kinds=tool&errors_only=1');
  });
});

describe('OverviewPage', () => {
  it('renders tiles from the API and patches live sessions from the system topic', async () => {
    const view = mount();
    await screen.findByText('Sessions · 7d');
    expect(within(tile('Tool calls · 7d')).getByText('46')).toBeTruthy();
    expect(within(tile('Errors · 7d')).getByText('4.3% of calls · 30 all-time')).toBeTruthy();
    await waitFor(() => expect(within(tile('Live sessions')).getByText('2')).toBeTruthy());
    expect(tile('Blocked URLs · 7d').getAttribute('href')).toBe('/blocklist');
    expect(tile('Live sessions').getAttribute('href')).toBe('/sessions?view=live');
    await waitFor(() => expect(view.sockets.length).toBe(1));
    act(() => {
      view.connect();
      view.emit('system', { type: 'system.capacity', live: 5, max: 8 });
    });
    await waitFor(() => expect(within(tile('Live sessions')).getByText('5')).toBeTruthy());
    await waitFor(() =>
      expect(view.container.querySelector('[data-url*="example1.com/path"]')).not.toBeNull(),
    );
    await expectNoA11yViolations(view.container);
  });

  it('does not reload or flash skeletons when the minute rolls over', async () => {
    let now = 1_700_000_000_000 + 50_000;
    const clock = new ServerClock(() => now);
    takeWindowAnchor(now, true);
    const view = renderPage({
      path: '/overview',
      component: function ClockedOverview() {
        return (
          <ServerClockContext.Provider value={clock}>
            <OverviewPage />
          </ServerClockContext.Provider>
        );
      },
      validateSearch: (search) => overviewSearch.parse(search),
      routes: routes(),
      url: '/overview',
    });
    await screen.findByText('Sessions · 7d');
    await screen.findByTestId('activity-chart');
    const activityCalls = () => view.requests.filter((r) => r.path === '/api/v1/activity').length;
    const before = activityCalls();
    const sinceBefore = view.requests
      .find((r) => r.path === '/api/v1/activity')
      ?.query.get('since');
    await waitFor(() => expect(view.sockets.length).toBe(1));
    // Two minutes later something re-renders the page (a live capacity update).
    now += 125_000;
    act(() => {
      view.connect();
      view.emit('system', { type: 'system.capacity', live: 3, max: 8 });
    });
    await waitFor(() => expect(within(tile('Live sessions')).getByText('3')).toBeTruthy());
    // Same keys: no new request, no skeleton, the chart and tiles stay mounted.
    expect(activityCalls()).toBe(before);
    expect(screen.queryByLabelText('Loading chart')).toBeNull();
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByTestId('activity-chart')).toBeTruthy();
    expect(view.requests.find((r) => r.path === '/api/v1/activity')?.query.get('since')).toBe(
      sinceBefore,
    );
  });

  it('writes the range to the URL and clears custom bounds', async () => {
    const view = mount('/overview?since=1000&until=2000');
    await screen.findByText('Sessions · custom');
    const group = screen.getByRole('group', { name: 'Time range' });
    fireEvent.click(within(group).getByRole('button', { name: 'Last 24h' }));
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ range: '24h' }));
    expect(view.router.state.location.search).not.toHaveProperty('since');
    await screen.findByText('Sessions · 24h');
    const activityCall = view.requests.filter((r) => r.path === '/api/v1/activity').at(-1);
    expect(activityCall?.query.get('bucket_ms')).toBe('3600000');
  });

  it('shows open degradations, links chart buckets and panel rows', async () => {
    const view = mount(
      '/overview',
      systemInfo({
        degradations: [
          {
            event_id: 'd1',
            code: 'RETENTION_FAILED',
            severity: 'error',
            message: 'retention pass failed',
            details: null,
            first_seen_at: NOW,
            last_seen_at: NOW,
            count: 3,
            resolved_at: null,
          },
        ],
      }),
    );
    await screen.findByText('1 degradation open');
    const chart = await screen.findByTestId('activity-chart');
    const bars = within(chart).getAllByRole('link');
    expect(bars.length).toBe(4);
    expect(bars[0]?.getAttribute('href')).toMatch(/^\/sessions\?since=\d+&until=\d+$/);
    const domain = await screen.findByRole('link', { name: /example1\.com: 3/ });
    expect(domain.getAttribute('href')).toBe('/websites?domain=example1.com');
    const failure = await screen.findByRole('link', { name: 'Open failed click in shop' });
    expect(failure.getAttribute('href')).toBe('/sessions/shop-a1b2c3d4?kinds=tool&errors_only=1');
    expect(screen.queryByText('Public')).toBeNull();
    const failuresCall = view.requests.find((r) => r.path === '/api/v1/tool-calls');
    expect(failuresCall?.query.get('has_session')).toBe('true');
    expect(view.container.querySelector('[aria-label="Quick actions"]')).toBeNull();
  });
});
