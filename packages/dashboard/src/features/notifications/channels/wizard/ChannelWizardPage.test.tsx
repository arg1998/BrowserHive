/** @module features/notifications/channels/wizard/ChannelWizardPage.test — the add-channel wizard: platform choice, the variable's live missing → set state (never a value), the draft in localStorage, Telegram one-tap connect (link + QR, then the chat and the allow-list owner), rules (Telegram TTL capped at 47 h, screenshots need Full, masking on by default), preview from the renderer and Save; axe clean */
import { afterEach, describe, expect, it } from 'bun:test';
import { ChannelPreview } from '@browserhive/contracts/http';
import { CAPTURED } from '../../../../../test/fixtures/channels.ts';
import { expectNoA11yViolations } from '../../../../../test/helpers/axe.ts';
import { type RecordedRequest, renderPage } from '../../../../../test/helpers/page-harness.tsx';
import { act, fireEvent } from '../../../../../test/helpers/render.tsx';
import { pickOption } from '../../../../../test/helpers/select.ts';
import { DRAFT_KEY, readDraft } from '../model.ts';
import { wizardSearch } from '../search.ts';
import { NewChannelPage } from './ChannelWizardPage.tsx';

const PREVIEW = ChannelPreview.parse(CAPTURED.previews.telegramPhoto);
const EXPIRES = 1_700_000_000_000 + 110_000;

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error('until timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const text = () => document.body.textContent ?? '';
/** The id of the Channel select (its label's `for`). */
const channelTrigger = () =>
  [...document.querySelectorAll('label')]
    .find((l) => l.textContent === 'Channel')
    ?.getAttribute('for') ?? '';

function mount(
  url: string,
  options: { envSet?: () => boolean; routes?: Record<string, unknown> } = {},
) {
  let polls = 0;
  const created: unknown[] = [];
  const view = renderPage({
    path: '/notifications/channels/new',
    component: NewChannelPage,
    validateSearch: (s) => wizardSearch.parse(s),
    url,
    routes: {
      'GET /channels': { data: [], now: 1 },
      'GET /channels/env': (req: RecordedRequest) => {
        polls += 1;
        const names = (req.query.get('names') ?? '').split(',');
        return { vars: names.map((name) => ({ name, set: options.envSet?.() ?? true })) };
      },
      'POST /channels/preview': PREVIEW,
      'POST /channels/telegram/connect': {
        connect_id: 'cx-demo-1234',
        bot_username: 'my_browserhive_bot',
        link: 'https://t.me/my_browserhive_bot?start=bh-4f9k2m',
        group_link: 'https://t.me/my_browserhive_bot?startgroup=bh-4f9k2m',
        expires_at: EXPIRES,
      },
      'GET /channels/telegram/connect/cx-demo-1234': {
        status: 'connected',
        chat: { id: '-1001234567890', title: 'Family ops', type: 'supergroup', thread_id: null },
        user: { id: '42', name: 'Amir' },
        error: null,
        expires_at: EXPIRES,
      },
      'POST /channels': (req: RecordedRequest) => {
        created.push(req.body);
        const body = req.body as { name: string };
        return {
          status: 201,
          body: {
            channel: {
              ...CAPTURED.channels.data[0],
              name: body.name,
              channel_id: 'nc-newchannel1',
            },
          },
        };
      },
      ...options.routes,
    },
  });
  return { ...view, created, polls: () => polls };
}

const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const button = (label: RegExp) => {
  const found = [...document.querySelectorAll('button')].find((b) =>
    label.test(b.textContent ?? ''),
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};

afterEach(() => localStorage.removeItem(DRAFT_KEY));

describe('channel wizard', () => {
  it('connects a Discord bot: invite, server and channel, "This is me"', async () => {
    const GUILD = '111111111111111111';
    const CHANNEL = '222222222222222222';
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        v: 1,
        kind: 'discord',
        mode: 'bot',
        name: 'ops-bot',
        target: {},
        secretRefs: { token: 'BH_DISCORD_BOT_TOKEN' },
        rules: { categories: ['needs-you'], act_buttons: true },
      }),
    );
    let polled = 0;
    const view = mount('/notifications/channels/new?step=connect', {
      routes: {
        'POST /channels/discord/bot': {
          application_id: '333333333333333333',
          bot_id: '333333333333333333',
          bot_username: 'BrowserHive Bot',
          invite_url:
            'https://discord.com/oauth2/authorize?client_id=333333333333333333&scope=bot&permissions=52224',
          guilds: [{ id: GUILD, name: 'Home' }],
        },
        'POST /channels/discord/channels': {
          channels: [{ id: CHANNEL, name: 'alerts', type: 'text', category: null }],
        },
        'POST /channels/discord/connect': { connect_id: 'dx-demo-1234', expires_at: EXPIRES },
        'GET /channels/discord/connect/dx-demo-1234': () => {
          polled += 1;
          return {
            status: 'connected',
            user: { id: '444444444444444444', name: 'Amir' },
            error: null,
            expires_at: EXPIRES,
          };
        },
      },
    });
    await until(() => text().includes('BrowserHive Bot'));
    const invite = [...document.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Invite the bot'),
    );
    expect(invite?.getAttribute('href')).toContain('permissions=52224');
    // The only server is picked; then the channel.
    await until(() => readDraft()?.target['guild_id'] === GUILD);
    expect(readDraft()?.target['guild_name']).toBe('Home');
    await until(() => view.requests.some((r) => r.path.endsWith('/discord/channels')));
    const trigger = () => document.getElementById(channelTrigger()) as HTMLElement;
    await until(() => trigger() !== null && !trigger().hasAttribute('data-disabled'));
    await pickOption(trigger(), '#alerts');
    await until(() => readDraft()?.target['channel_id'] === CHANNEL);
    expect(readDraft()?.target['channel_name']).toBe('alerts');
    await click(button(/Send the link message/));
    await until(() => text().includes('Connected as Amir'));
    expect(polled).toBeGreaterThan(0);
    expect(readDraft()?.rules.allow_list?.[0]).toBe('444444444444444444');
    await expectNoA11yViolations(view.container);
  }, 30_000);

  it('walks Telegram: platform, credentials, connect, rules', async () => {
    let set = false;
    const view = mount('/notifications/channels/new', { envSet: () => set });
    await until(() => text().includes('Where should notifications go?'));
    await expectNoA11yViolations(view.container);
    const telegram = document.querySelector('input[value="telegram"]');
    if (telegram === null) throw new Error('no telegram radio');
    await click(telegram);
    expect(readDraft()?.kind).toBe('telegram');
    await click(button(/Continue/));

    // Credentials: the suggested variable, missing until the server sees it.
    await until(() => text().includes('Where to get it'));
    expect((document.querySelector('input[placeholder="BH_…"]') as HTMLInputElement).value).toBe(
      'BH_TELEGRAM_TOKEN',
    );
    await until(() => text().includes('missing'));
    expect(text()).toContain('BH_TELEGRAM_TOKEN is not set yet');
    set = true;
    await until(() => text().includes('set') && !text().includes('is not set yet'), 6000);
    await click(button(/Continue/));

    // Connect: one-tap link, then the captured chat and the allow-list owner.
    await until(() => text().includes('Connect a chat in one tap'));
    await click(button(/Create the connect link/));
    await until(() => text().includes('Connected to Family ops'));
    expect(readDraft()?.target['chat_id']).toBe('-1001234567890');
    expect(readDraft()?.rules.allow_list).toEqual(['42']);
    await click(button(/Continue/));

    // Rules: Telegram TTL stops at 47 h; screenshots need Full and mask by default.
    await until(() => text().includes('What should reach you here?'));
    if (!text().includes('Categories')) await click(button(/Advanced/));
    await until(() => text().includes('Self-destruct'));
    expect(text()).toContain('47 hours');
    const shots = [...document.querySelectorAll('[role="switch"]')];
    expect(text()).toContain('Screenshots need the Full content level.');
    const full = document.querySelector('input[value="full"]');
    if (full === null) throw new Error('no full radio');
    await click(full);
    await until(() => text().includes('Attach a screenshot'));
    expect(shots.length).toBeGreaterThan(0);
  }, 30_000);

  it('previews the draft and saves it', async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        v: 1,
        kind: 'telegram',
        mode: null,
        name: 'phone',
        target: { chat_id: '-1001234567890', chat_title: 'Family ops' },
        secretRefs: { token: 'BH_TELEGRAM_TOKEN' },
        rules: { categories: ['needs-you'] },
      }),
    );
    const view = mount('/notifications/channels/new?step=preview');
    await until(() => document.querySelector('[data-platform="telegram"]') !== null);
    await expectNoA11yViolations(view.container);
    await click(button(/Save channel/));
    await until(() => text().includes('phone is saved'));
    expect(view.created[0]).toMatchObject({
      name: 'phone',
      kind: 'telegram',
      secret_refs: { token: 'BH_TELEGRAM_TOKEN' },
    });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(text()).toContain('Send a real test');
  }, 20_000);
});
