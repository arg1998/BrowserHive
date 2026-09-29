/** @module features/notifications/channels/log/DeliveryLogPage.test — reports in the delivery log (D-43): the window in the channel's zone, the late pill with the skipped count, the on-demand pill, an empty digest explained in words; axe clean */
import { describe, expect, it } from 'bun:test';
import { ChannelsResponse, type DeliveryRow } from '@browserhive/contracts/http';
import { CAPTURED } from '../../../../../test/fixtures/channels.ts';
import { expectNoA11yViolations } from '../../../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../../../test/helpers/page-harness.tsx';
import { screen, within } from '../../../../../test/helpers/render.tsx';
import { deliveryLogSearch } from '../search.ts';
import { DeliveryLogPage } from './DeliveryLogPage.tsx';

const LIST = ChannelsResponse.parse(CAPTURED.channels);
const BASE = CAPTURED.deliveries.data[0] as DeliveryRow;
const NINE = Date.UTC(2026, 8, 29, 7);

function row(overrides: Partial<DeliveryRow>): DeliveryRow {
  return { ...BASE, ...overrides };
}

const ROWS: DeliveryRow[] = [
  row({
    seq: 3,
    notification_kind: 'digest.daily',
    notification_title: 'Daily digest · Tue 29 Sep',
    reason: null,
    status: 'sent',
    report: {
      window: { since: NINE - 86_400_000, until: NINE },
      time_zone: 'Europe/Berlin',
      late: true,
      skipped: 2,
      manual: false,
    },
  }),
  row({
    seq: 2,
    notification_kind: 'digest.daily',
    notification_title: 'Daily digest · Mon 28 Sep',
    status: 'suppressed',
    reason: 'empty',
    report: {
      window: { since: NINE - 2 * 86_400_000, until: NINE - 86_400_000 },
      time_zone: 'Europe/Berlin',
      late: false,
      skipped: 0,
      manual: false,
    },
  }),
  row({
    seq: 1,
    notification_kind: 'digest.daily',
    notification_title: 'Daily digest · Tue 29 Sep',
    reason: 'manual',
    report: {
      window: { since: NINE - 86_400_000, until: NINE },
      time_zone: 'Europe/Berlin',
      late: false,
      skipped: 0,
      manual: true,
    },
  }),
];

describe('DeliveryLogPage reports', () => {
  it('shows the window, the late pill and why an empty digest was not sent', async () => {
    const view = renderPage({
      path: '/',
      component: DeliveryLogPage,
      validateSearch: (s) => deliveryLogSearch.parse(s),
      url: '/',
      routes: {
        'GET /channels': LIST,
        'GET /channels/deliveries': envelope(ROWS),
      },
    });
    const late = await screen.findByText('late');
    const item = late.closest('li');
    if (item === null) throw new Error('no row');
    expect(within(item).getByText('Mon 28 Sep, 09:00 → Tue 29 Sep, 09:00')).toBeDefined();
    expect(screen.getByText('on demand')).toBeDefined();
    expect(
      screen.getByText('Nothing happened in the period of this digest, so nothing was sent.'),
    ).toBeDefined();
    await expectNoA11yViolations(view.container);
  });
});
