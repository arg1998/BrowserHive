/** @module features/notifications/reports/ReportsPage.test — the Reports tab (D-45, spec 04 §12.11.2): the in-app schedule (off by default, saved with PUT, read-only without channels:write), the history with kind, channel and late/on-demand markers, the filters sent to the server, the report page drawn natively (facts, chart with its data table, tables) with "Open Overview for this period" and the channels it reached; axe clean */
import { describe, expect, it } from 'bun:test';
import { ChannelsResponse, type ReportSettingsResponse } from '@browserhive/contracts/http';
import { CAPTURED } from '../../../../test/fixtures/channels.ts';
import {
  ANOMALY_MESSAGE,
  DIGEST_MESSAGE,
  reportItem,
  WEEKLY_MESSAGE,
} from '../../../../test/fixtures/reports.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import {
  envelope,
  type RecordedRequest,
  renderPage,
} from '../../../../test/helpers/page-harness.tsx';
import { fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { ReportPage } from './ReportPage.tsx';
import { ReportsPage } from './ReportsPage.tsx';
import { reportsSearch } from './search.ts';

const LIST = ChannelsResponse.parse(CAPTURED.channels);
const PHONE = LIST.data[0];
if (PHONE === undefined) throw new Error('no channel fixture');

const SETTINGS: ReportSettingsResponse = {
  settings: {},
  host_time_zone: 'Europe/Berlin',
  reports: { time_zone: 'Europe/Berlin', host_zone: true, digest: null, anomaly: null },
};

const ITEMS = [
  reportItem(ANOMALY_MESSAGE, [
    {
      channel_id: PHONE.channel_id,
      name: PHONE.name,
      kind: PHONE.kind,
      status: 'sent',
      reason: null,
    },
  ]),
  reportItem(WEEKLY_MESSAGE),
  reportItem(DIGEST_MESSAGE, [
    {
      channel_id: PHONE.channel_id,
      name: PHONE.name,
      kind: PHONE.kind,
      status: 'dead',
      reason: null,
    },
  ]),
];

function page(scopes?: readonly string[]) {
  return renderPage({
    path: '/',
    component: ReportsPage,
    validateSearch: (s) => reportsSearch.parse(s),
    url: '/',
    routes: {
      'GET /channels': LIST,
      'GET /notifications/report-settings': SETTINGS,
      'PUT /notifications/report-settings': (request: RecordedRequest) => ({
        ...SETTINGS,
        settings: (request.body as { settings: ReportSettingsResponse['settings'] }).settings,
      }),
      'GET /notifications/reports': envelope(ITEMS),
    },
    ...(scopes !== undefined && { scopes }),
  });
}

describe('ReportsPage', () => {
  it('lists every report once with its markers and channels', async () => {
    const view = page();
    const list = await screen.findByRole('list', { name: 'Reports' });
    const rows = within(list).getAllByRole('listitem', { hidden: false });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(within(list).getByText(ANOMALY_MESSAGE.title)).toBeDefined();
    // The anomaly alert is active; the weekly digest was late and reached no channel.
    expect(within(list).getByText('active')).toBeDefined();
    expect(within(list).getByText('late')).toBeDefined();
    expect(within(list).getByText('Only in BrowserHive')).toBeDefined();
    expect(within(list).getAllByRole('list', { name: 'Sent to' })).toHaveLength(2);
    await expectNoA11yViolations(view.container);
  });

  it('sends the filters to the server', async () => {
    const view = page();
    await screen.findByRole('list', { name: 'Reports' });
    fireEvent.click(screen.getByRole('button', { name: 'Anomaly alert' }));
    await waitFor(() => {
      const last = view.requests.filter((r) => r.path.endsWith('/notifications/reports')).at(-1);
      expect(last?.query.get('kind')).toBe('report.anomaly');
    });
  });

  it('switches the in-app digest on and saves it', async () => {
    const view = page();
    const form = await screen.findByRole('form', { name: 'Reports in BrowserHive' });
    const save = within(form).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(form).getByRole('button', { name: 'Every week' }));
    expect(within(form).getByText(/Fri \d+ \w+, 17:00/)).toBeDefined();
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const put = view.requests.find((r) => r.method === 'PUT');
      expect(put?.body).toEqual({
        settings: { digest: { every: 'week', at: '17:00', day: 'fri' } },
      });
    });
    await expectNoA11yViolations(view.container);
  });

  it('is read-only without channels:write, saying why', async () => {
    page(['notifications:read', 'channels:read']);
    const form = await screen.findByRole('form', { name: 'Reports in BrowserHive' });
    expect(within(form).getByText('Needs the channels:write permission.')).toBeDefined();
    expect(within(form).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('ReportPage', () => {
  function report(item: (typeof ITEMS)[number], message = DIGEST_MESSAGE) {
    return renderPage({
      path: '/notifications/reports/$notificationId',
      component: ReportPage,
      url: `/notifications/reports/${item.notification.notification_id}`,
      routes: {
        [`GET /notifications/reports/${item.notification.notification_id}`]: {
          report: item,
          message,
        },
        [`POST /notifications/${item.notification.notification_id}/read`]: { ok: true },
      },
    });
  }

  it('draws a digest natively with its window, chart, tables and channels', async () => {
    const item = ITEMS[2];
    if (item === undefined) throw new Error('no item');
    const view = report(item);
    expect(await screen.findByRole('heading', { name: DIGEST_MESSAGE.title })).toBeDefined();
    expect(
      screen.getByText(/Mon 28 Sep, 09:00 → Tue 29 Sep, 09:00 · Europe\/Berlin/),
    ).toBeDefined();
    // Facts as a description list, the chart as an image with a data table, real tables.
    expect(screen.getAllByText('Sessions')[0]?.tagName.toLowerCase()).toBe('dt');
    const chart = screen.getByRole('img', { name: /Tool calls per hour/ });
    expect(chart.tagName.toLowerCase()).toBe('svg');
    expect(screen.getAllByRole('table').length).toBeGreaterThanOrEqual(2);
    const overview = screen.getByRole('link', { name: 'Open Overview for this period' });
    expect(overview.getAttribute('href')).toBe(
      `/overview?since=${DIGEST_MESSAGE.report?.window.since}&until=${DIGEST_MESSAGE.report?.window.until}`,
    );
    const sentTo = screen.getByRole('link', { name: /open the delivery log/ });
    expect(sentTo.textContent).toBe('failed');
    await expectNoA11yViolations(view.container);
  });

  it('marks an unread anomaly alert read when it is opened', async () => {
    const item = ITEMS[0];
    if (item === undefined) throw new Error('no item');
    const view = report(item, ANOMALY_MESSAGE);
    expect(await screen.findByRole('heading', { name: ANOMALY_MESSAGE.title })).toBeDefined();
    expect(screen.getByText('active')).toBeDefined();
    await waitFor(() => {
      expect(view.requests.some((r) => r.method === 'POST' && r.path.endsWith('/read'))).toBe(true);
    });
  });

  it('says so when a report reached no channel, and marks it late', async () => {
    const item = ITEMS[1];
    if (item === undefined) throw new Error('no item');
    report(item, WEEKLY_MESSAGE);
    expect(await screen.findByText(/Only in BrowserHive/)).toBeDefined();
    expect(screen.getByText('late · 2 skipped')).toBeDefined();
  });
});
