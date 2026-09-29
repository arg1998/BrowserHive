/** @module features/notifications/channels/ChannelsPage.test — channel cards from captured API responses: startup badge (read-only, no menu), a broken channel with Resume and retry, a missing variable (never a value), Send test with the result inline, delete confirm, the publicUrl hint, live `channel.changed` / `channel.removed`, the empty state, axe clean */
import { describe, expect, it } from 'bun:test';
import type { ChannelView } from '@browserhive/contracts/http';
import { ChannelPreview, ChannelsResponse, PublicUrlStatus } from '@browserhive/contracts/http';
import { CAPTURED } from '../../../../test/fixtures/channels.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { type RecordedRequest, renderPage } from '../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../../test/helpers/render.tsx';
import { ChannelsPage, sortChannels } from './ChannelsPage.tsx';

const LIST = ChannelsResponse.parse(CAPTURED.channels);
const PUBLIC = PublicUrlStatus.parse({
  ...CAPTURED.publicUrl,
  configured: false,
  url: null,
  outcome: 'unset',
});
const byName = (name: string): ChannelView => {
  const found = LIST.data.find((c) => c.name === name);
  if (found === undefined) throw new Error(`fixture lacks ${name}`);
  return found;
};

function mount(routes: Record<string, unknown> = {}) {
  return renderPage({
    path: '/notifications/channels',
    component: ChannelsPage,
    url: '/notifications/channels',
    routes: {
      'GET /channels': LIST,
      'GET /system/public-url': PUBLIC,
      ...routes,
    },
  });
}

/** A card by its channel name (a plain DOM lookup: role queries over many cards are slow in happy-dom). */
function findCard(name: string): HTMLElement | null {
  const heading = [...document.querySelectorAll('article h2')].find((h) => h.textContent === name);
  return heading?.closest('article') ?? null;
}

function card(name: string): HTMLElement {
  const found = findCard(name);
  if (found === null) throw new Error(`no card ${name}`);
  return found;
}

/** Waits until `check` holds, polling with real timers. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error('until timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('ChannelsPage', () => {
  it('sorts channels by name', () => {
    expect(sortChannels(LIST.data).map((c) => c.name)).toEqual(
      [...LIST.data.map((c) => c.name)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('renders every channel with its state and is accessible', async () => {
    const view = mount();
    await until(() => findCard('family') !== null);
    // Startup channel: badge, no Edit/Duplicate/Delete menu.
    const pager = card('pager');
    expect(within(pager).getByText('from startup')).toBeDefined();
    expect(within(pager).queryByRole('button', { name: /More actions/ })).toBeNull();
    // A channel with a missing variable shows the name and "missing", never a value.
    const ha = card('home-assistant');
    expect(within(ha).getByText('BH_WEBHOOK_SECRET')).toBeDefined();
    expect(within(ha).getByText('is missing')).toBeDefined();
    expect(
      within(ha)
        .getByRole('button', { name: /Send test/ })
        .hasAttribute('disabled'),
    ).toBe(true);
    // The public address hint.
    expect(screen.getByText('Links in notifications open on this computer only')).toBeDefined();
    await expectNoA11yViolations(view.container);
  });

  it('shows a broken channel with its error and Resume and retry', async () => {
    const view = mount({
      [`POST /channels/${byName('old-hook').channel_id}/resume`]: {
        channel: { ...byName('old-hook'), status: 'active', failure_count: 0 },
      },
    });
    await until(() => findCard('old-hook') !== null);
    const hook = card('old-hook');
    expect(within(hook).getByText(/Paused after 5 failures/)).toBeDefined();
    fireEvent.click(within(hook).getByRole('button', { name: /Resume and retry/ }));
    await waitFor(() =>
      expect(view.requests.some((r) => r.path.endsWith('/resume') && r.method === 'POST')).toBe(
        true,
      ),
    );
    await until(() => card('old-hook').textContent?.includes('Pause') === true);
  });

  it('sends a test and shows the result inline', async () => {
    const family = byName('family');
    mount({
      [`POST /channels/${family.channel_id}/test`]: {
        ok: false,
        delivery: null,
        error: { code: 'auth', message: 'Telegram refused the token (401)' },
      },
    });
    await until(() => findCard('family') !== null);
    fireEvent.click(within(card('family')).getByRole('button', { name: /Send test/ }));
    expect(await within(card('family')).findByText(/Test failed/)).toBeDefined();
    expect(within(card('family')).getByText('Telegram refused the token (401)')).toBeDefined();
  });

  it('shows the next digest and the anomaly state, and sends a digest now (D-43, D-44)', async () => {
    const family = byName('family');
    const withReports: ChannelView = {
      ...family,
      rules: { ...family.rules, digest: { every: 'day', at: '09:00' }, anomaly: {} },
      reports: {
        time_zone: 'Asia/Tokyo',
        host_zone: false,
        digest: {
          every: 'day',
          at: '09:00',
          day: null,
          next_at: Date.UTC(2026, 8, 30, 0),
          last_until: null,
        },
        anomaly: {
          next_check_at: Date.UTC(2026, 8, 29, 13),
          active: [{ check: 'error_rate', since: 1, value: 34, threshold: 20 }],
        },
      },
    };
    const preview = ChannelPreview.parse({ ...CAPTURED.previews.telegramPhoto, sample: 'digest' });
    const window = { since: Date.UTC(2026, 8, 28, 12), until: Date.UTC(2026, 8, 29, 12) };
    const view = mount({
      'GET /channels': {
        ...LIST,
        data: LIST.data.map((c) => (c.name === 'family' ? withReports : c)),
      },
      [`POST /channels/${family.channel_id}/digest`]: (req: RecordedRequest) =>
        (req.body as { send: boolean }).send
          ? {
              preview,
              window,
              empty: false,
              sent: true,
              ok: true,
              delivery: { ...CAPTURED.deliveries.data[0], duration_ms: 312 },
              error: null,
            }
          : { preview, window, empty: true, sent: false, ok: true, delivery: null, error: null },
    });
    await until(() => findCard('family') !== null);
    const c = card('family');
    expect(within(c).getByText('Daily digest')).toBeDefined();
    expect(within(c).getByText(/next Wed 30 Sep, 09:00 \(Asia\/Tokyo\)/)).toBeDefined();
    expect(within(c).getByText(/error rate 34%/)).toBeDefined();
    await act(async () => {
      fireEvent.click(within(c).getByRole('button', { name: 'Send now' }));
    });
    expect(await screen.findByRole('heading', { name: 'Send a digest now' })).toBeDefined();
    expect(await screen.findByText('Nothing happened in this period')).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send now/ }));
    });
    expect(await screen.findByText(/Digest sent/)).toBeDefined();
    const posts = view.requests.filter((r) => r.path.endsWith('/digest'));
    expect(posts.map((r) => (r.body as { send: boolean }).send)).toEqual([false, true]);
  });

  it('asks before deleting and removes the card', async () => {
    const phone = byName('phone');
    mount({ [`DELETE /channels/${phone.channel_id}`]: { ok: true } });
    await until(() => findCard('phone') !== null);
    await act(async () => {
      fireEvent.click(
        within(card('phone')).getByRole('button', { name: /More actions for phone/ }),
      );
    });
    const item = await screen.findByRole('menuitem', { name: /Delete/ });
    await act(async () => {
      fireEvent.click(item);
    });
    const confirm = await screen.findByRole('button', { name: 'Delete channel' });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await until(() => findCard('phone') === null);
  });

  it('follows channel.changed and channel.removed', async () => {
    const view = mount();
    await until(() => findCard('family') !== null);
    await until(() => view.sockets.length === 1);
    view.connect();
    view.emit('channels', {
      type: 'channel.changed',
      channel: { ...byName('family'), status: 'paused' },
    });
    await until(() => card('family').textContent?.includes('paused') === true);
    view.emit('channels', { type: 'channel.removed', channel_id: byName('team').channel_id });
    await until(() => findCard('team') === null);
  });

  it('shows who answers from the chat and the press listener', async () => {
    const family = byName('family');
    const team = byName('team');
    mount({
      'GET /channels': {
        ...LIST,
        data: [
          {
            ...family,
            rules: { ...family.rules, act_buttons: true, allow_list: ['1', '2'] },
            connection: { state: 'connected', since: 1, detail: null },
          },
          {
            ...team,
            mode: 'bot',
            target: { channel_id: '9', channel_name: 'alerts', guild_name: 'Home' },
            rules: { act_buttons: true },
            connection: { state: 'offline', since: 1, detail: 'Discord refused the token (401)' },
          },
        ],
      },
    });
    await until(() => findCard('team') !== null);
    expect(within(card('family')).getByText('Answers from the chat')).toBeDefined();
    expect(within(card('family')).getByText('2 people may answer')).toBeDefined();
    expect(within(card('team')).getByText('Discord refused the token (401)')).toBeDefined();
    expect(card('team').textContent).toContain('Discord bot · #alerts in Home');
  });

  it('explains channels when there are none', async () => {
    mount({ 'GET /channels': { data: [], now: 1 } });
    expect(await screen.findByText('Get notified on your phone')).toBeDefined();
    expect(screen.getByRole('link', { name: /Add a channel/ })).toBeDefined();
  });
});
