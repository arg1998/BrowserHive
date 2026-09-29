/** @module features/notifications/channels/actions/ActionsPage.test — the act-button audit: rows with the outcome and its sentence linking to the delivery log, the outcome filter in the query, "Allow this person" on a refused press (confirm, read the channel, save the allow-list with the id appended; disabled with the `allow=` hint on a startup channel; only for Telegram and Discord pressers), a live `action.recorded`, the empty state, axe clean */
import { describe, expect, it } from 'bun:test';
import type { ActionRow, ChannelView } from '@browserhive/contracts/http';
import { ChannelsResponse } from '@browserhive/contracts/http';
import { CAPTURED } from '../../../../../test/fixtures/channels.ts';
import { expectNoA11yViolations } from '../../../../../test/helpers/axe.ts';
import {
  envelope,
  type RecordedRequest,
  renderPage,
} from '../../../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor } from '../../../../../test/helpers/render.tsx';
import { actionsSearch } from '../search.ts';
import { ActionsPage, actorParts, allowableId } from './ActionsPage.tsx';

const LIST = ChannelsResponse.parse(CAPTURED.channels);
const family = LIST.data.find((c) => c.name === 'family') as ChannelView;
const PHONE: ChannelView = {
  ...family,
  rules: { ...family.rules, act_buttons: true, allow_list: ['1111'] },
};
const OPS: ChannelView = {
  ...(LIST.data.find((c) => c.name === 'team') as ChannelView),
  name: 'ops-bot',
  mode: 'bot',
  source: 'startup',
  rules: { act_buttons: true },
};

function row(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    seq: 1,
    at: 1_700_000_000_000,
    channel_id: PHONE.channel_id,
    channel_name: PHONE.name,
    channel_kind: 'telegram',
    notification_id: 'n-000000000001',
    notification_title: 'Attention requested on example.com',
    action_id: 'resolve',
    action_label: 'Mark resolved',
    op: 'attention.resolve',
    actor: 'telegram:1111',
    actor_name: 'Amir',
    outcome: 'done',
    detail: 'Marked resolved.',
    ...overrides,
  };
}

const REFUSED = row({
  seq: 3,
  actor: 'telegram:2222',
  actor_name: 'Sam',
  outcome: 'not_allowed',
  detail: 'You are not allowed to answer here yet.',
});
const REFUSED_STARTUP = row({
  seq: 2,
  channel_id: OPS.channel_id,
  channel_name: OPS.name,
  channel_kind: 'discord',
  actor: 'discord:3333',
  actor_name: null,
  outcome: 'not_allowed',
});

function mount(rows: readonly ActionRow[], routes: Record<string, unknown> = {}, url = '/') {
  return renderPage({
    path: '/',
    component: ActionsPage,
    validateSearch: (s) => actionsSearch.parse(s),
    url,
    routes: {
      'GET /channels': { ...LIST, data: [PHONE, OPS] },
      'GET /channels/actions': (req: RecordedRequest) => {
        const outcome = req.query.get('outcome');
        return envelope(
          outcome === null ? rows : rows.filter((r) => outcome.split(',').includes(r.outcome)),
        );
      },
      ...routes,
    },
  });
}

describe('ActionsPage', () => {
  it('names the presser and the id to allow', () => {
    expect(actorParts({ actor: 'telegram:42', actor_name: null })).toEqual({
      name: 'Telegram user',
      platform: 'Telegram',
      id: '42',
    });
    expect(actorParts({ actor: 'ntfy:topic-b', actor_name: null }).platform).toBe(
      'ntfy reply topic',
    );
    expect(allowableId({ actor: 'discord:3333', outcome: 'not_allowed' })).toBe('3333');
    expect(allowableId({ actor: 'discord:3333', outcome: 'done' })).toBeNull();
    expect(allowableId({ actor: 'ntfy:topic-b', outcome: 'not_allowed' })).toBeNull();
  });

  it('lists presses with their outcome, linked to the delivery log, and is accessible', async () => {
    const view = mount([REFUSED, REFUSED_STARTUP, row()]);
    expect(await screen.findByText('Sam')).toBeDefined();
    expect(screen.getAllByText('Refused: not on the allow-list.').length).toBe(2);
    expect(screen.getByText('Marked resolved.')).toBeDefined();
    const links = screen.getAllByRole('link', { name: /open its deliveries/ });
    expect(links.length).toBe(3);
    expect(links[0]?.getAttribute('href')).toContain('/notifications/log?notification=');
    await expectNoA11yViolations(view.container);
  });

  it('allows a refused presser after a confirmation', async () => {
    let saved: unknown = null;
    const view = mount([REFUSED], {
      [`GET /channels/${PHONE.channel_id}`]: { channel: PHONE },
      [`PATCH /channels/${PHONE.channel_id}`]: (req: RecordedRequest) => {
        saved = req.body;
        return { channel: { ...PHONE, rules: { ...PHONE.rules, allow_list: ['1111', '2222'] } } };
      },
    });
    const allow = await screen.findByRole('button', { name: /Allow this person/ });
    await act(async () => {
      fireEvent.click(allow);
    });
    expect(await screen.findByText('Allow Sam to answer on family?')).toBeDefined();
    const buttons = screen.getAllByRole('button', { name: 'Allow this person' });
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    });
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved).toEqual({ rules: { ...PHONE.rules, allow_list: ['1111', '2222'] } });
    expect(view.requests.some((r) => r.method === 'GET' && r.path.endsWith(PHONE.channel_id))).toBe(
      true,
    );
    expect((await screen.findAllByText('Sam can now answer on family')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Allowed now')).toBeDefined();
  });

  it('points a startup channel to its allow= parameter', async () => {
    mount([REFUSED_STARTUP]);
    const allow = await screen.findByRole('button', { name: /Allow this person/ });
    expect(allow.hasAttribute('disabled')).toBe(true);
    expect(allow.getAttribute('title')).toContain('allow=3333');
  });

  it('offers no allow for ntfy or other outcomes', async () => {
    mount([
      row({ seq: 5, actor: 'ntfy:topic-b', actor_name: null, outcome: 'not_allowed' }),
      row({ seq: 4, outcome: 'expired', detail: null }),
    ]);
    expect(await screen.findByText('Someone with the topic')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Allow this person/ })).toBeNull();
  });

  it('filters by outcome through the query', async () => {
    const view = mount([REFUSED, row()], {}, '/?outcome=not_allowed');
    expect(await screen.findByText('Sam')).toBeDefined();
    expect(screen.queryByText('Amir')).toBeNull();
    expect(
      view.requests.some(
        (r) => r.path.endsWith('/channels/actions') && r.query.get('outcome') === 'not_allowed',
      ),
    ).toBe(true);
  });

  it('adds a live press to the top', async () => {
    const view = mount([row()]);
    expect(await screen.findByText('Amir')).toBeDefined();
    await waitFor(() => expect(view.sockets.length).toBe(1));
    view.connect();
    view.emit('channels', { type: 'action.recorded', action: REFUSED });
    expect(await screen.findByText('Sam')).toBeDefined();
  });

  it('explains the audit when nothing was pressed yet', async () => {
    mount([]);
    expect(await screen.findByRole('link', { name: /Go to channels/ })).toBeDefined();
  });
});
