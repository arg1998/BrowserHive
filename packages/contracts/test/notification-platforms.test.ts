/** @module contracts/test/notification-platforms.test — the per-platform channel check shared by the API, the startup flag and the dashboard (spec 03 §9.5, D-33), the reason texts and the public-URL grammar */
import { describe, expect, it } from 'bun:test';
import { zPublicUrl } from '../src/config/index.ts';
import { NotificationActionOutcome } from '../src/enums/index.ts';
import { ChannelInput, ChannelPreviewRequest } from '../src/http/index.ts';
import {
  ACTION_OUTCOME_TEXT,
  ACTION_PAYLOAD_RE,
  CHANNEL_KIND_SPECS,
  checkChannelConfig,
  checkChannelRules,
  DISCORD_BOT_PERMISSIONS,
  deliveryReasonText,
  discordInviteUrl,
  looksLikeSecretValue,
  SUPPRESSION_REASONS,
  supportsActButtons,
} from '../src/notifications/index.ts';

const check = (
  kind: string,
  target: Record<string, string>,
  secretRefs: Record<string, string>,
  mode: string | null = null,
) => checkChannelConfig({ kind, mode, target, secretRefs }).map((p) => p.field);

describe('checkChannelConfig', () => {
  it('accepts a minimal channel of every platform', () => {
    expect(check('telegram', { chat_id: '-1001234567890' }, { token: 'BH_TG_TOKEN' })).toEqual([]);
    expect(check('discord', {}, { webhook: 'BH_DISCORD_WEBHOOK' }, 'webhook')).toEqual([]);
    expect(check('ntfy', { topic: 'bh-alerts' }, {})).toEqual([]);
    expect(
      check('ntfy', { server: 'https://ntfy.example.net' }, { topic: 'BH_NTFY_TOPIC' }),
    ).toEqual([]);
    expect(check('webhook', { url: 'https://hooks.example.net/bh?x=1' }, {})).toEqual([]);
  });

  it('requires the required keys and exactly one of a literal or a variable', () => {
    expect(check('telegram', {}, {})).toEqual(['target.chat_id', 'secret_refs.token']);
    expect(check('ntfy', {}, {})).toEqual(['target.topic']);
    expect(check('ntfy', { topic: 'a' }, { topic: 'B' })).toEqual(['target.topic']);
    expect(check('webhook', {}, {})).toEqual(['target.url']);
  });

  it('refuses a secret value where a variable name belongs, without echoing it', () => {
    const problems = checkChannelConfig({
      kind: 'telegram',
      mode: null,
      target: { chat_id: '1' },
      secretRefs: { token: '123:abc-def' },
    });
    expect(problems.map((p) => p.field)).toEqual(['secret_refs.token']);
    expect(problems[0]?.message).not.toContain('123:abc');
    expect(check('telegram', { chat_id: '1' }, { token: 'BROWSERHIVE_X' })).toEqual([
      'secret_refs.token',
    ]);
  });

  it('refuses unknown keys, unknown kinds, bad modes and bad values', () => {
    expect(check('telegram', { chat_id: '1', nope: 'x' }, { token: 'T' })).toEqual(['target.nope']);
    expect(check('slack', {}, {})).toEqual(['kind']);
    expect(check('discord', {}, { webhook: 'W' }, 'selfbot')).toEqual(['mode']);
    expect(check('telegram', { chat_id: 'abc' }, { token: 'T' })).toEqual(['target.chat_id']);
    expect(check('ntfy', { topic: 'has space' }, {})).toEqual(['target.topic']);
    expect(check('webhook', { url: 'file:///etc/passwd' }, {})).toEqual(['target.url']);
  });

  it('every platform suggests variable names outside the reserved prefix', () => {
    for (const spec of Object.values(CHANNEL_KIND_SPECS)) {
      for (const secret of spec.secrets) {
        expect(secret.suggestedEnv.startsWith('BROWSERHIVE_')).toBe(false);
        expect(looksLikeSecretValue(secret.suggestedEnv)).toBe(false);
      }
    }
  });
});

describe('Discord modes and the ntfy reply topic', () => {
  const channel = '112233445566778899';
  it("accepts a bot-mode channel and refuses the other mode's keys", () => {
    expect(check('discord', { channel_id: channel }, { token: 'BH_BOT' }, 'bot')).toEqual([]);
    expect(check('discord', {}, { token: 'BH_BOT' }, 'bot')).toEqual(['target.channel_id']);
    expect(check('discord', { channel_id: channel }, {}, 'bot')).toEqual(['secret_refs.token']);
    expect(check('discord', { channel_id: channel }, { webhook: 'W', token: 'T' }, 'bot')).toEqual([
      'secret_refs.webhook',
    ]);
    expect(check('discord', { channel_id: channel }, { webhook: 'W' }, 'webhook')).toEqual([
      'target.channel_id',
    ]);
    expect(check('discord', { channel_id: 'general' }, { token: 'T' }, 'bot')).toEqual([
      'target.channel_id',
    ]);
  });

  it('checks the reply topic', () => {
    expect(check('ntfy', { topic: 'a', reply_topic: 'b' }, {})).toEqual([]);
    expect(
      check('ntfy', { topic: 'a' }, { reply_topic: 'BH_REPLY', reply_token: 'BH_RT' }),
    ).toEqual([]);
    expect(check('ntfy', { topic: 'a', reply_topic: 'a' }, {})).toEqual(['target.reply_topic']);
    expect(check('ntfy', { topic: 'a', reply_topic: 'b' }, { reply_topic: 'B' })).toEqual([
      'target.reply_topic',
    ]);
    expect(check('ntfy', { topic: 'a', reply_topic: 'x y' }, {})).toEqual(['target.reply_topic']);
  });

  it('builds the invite link with the minimal permissions', () => {
    expect(DISCORD_BOT_PERMISSIONS).toBe((1 << 10) | (1 << 11) | (1 << 14) | (1 << 15));
    expect(discordInviteUrl('42')).toBe(
      'https://discord.com/oauth2/authorize?client_id=42&scope=bot&permissions=52224',
    );
  });
});

describe('act-button rules', () => {
  const rules = (kind: string, mode: string | null, r: object, target = {}, secretRefs = {}) =>
    checkChannelRules({ kind, mode, target, secretRefs, rules: r }).map((p) => p.field);

  it('allows act buttons only where presses can arrive', () => {
    expect(rules('telegram', null, { act_buttons: true, allow_list: ['123'] })).toEqual([]);
    expect(rules('discord', 'bot', { act_buttons: true })).toEqual([]);
    expect(rules('discord', 'webhook', { act_buttons: true })).toEqual(['rules.act_buttons']);
    expect(rules('ntfy', null, { act_buttons: true })).toEqual(['rules.act_buttons']);
    expect(rules('ntfy', null, { act_buttons: true }, { reply_topic: 'b' })).toEqual([]);
    expect(rules('ntfy', null, { act_buttons: true }, {}, { reply_topic: 'B' })).toEqual([]);
    expect(rules('webhook', null, { act_buttons: true })).toEqual([]);
    expect(rules('discord', 'webhook', { act_buttons: false })).toEqual([]);
    expect(supportsActButtons({ kind: 'discord', mode: null, target: {}, secretRefs: {} })).toBe(
      false,
    );
  });

  it('takes numeric user ids, and no allow-list where presses have no identity', () => {
    expect(rules('telegram', null, { allow_list: ['12', 'x1'] })).toEqual(['rules.allow_list']);
    expect(rules('ntfy', null, { allow_list: ['12'] }, { reply_topic: 'b' })).toEqual([
      'rules.allow_list',
    ]);
    expect(rules('discord', 'bot', { allow_list: ['112233445566778899'] })).toEqual([]);
  });

  it('explains every outcome and recognises button payloads', () => {
    for (const outcome of NotificationActionOutcome.options) {
      expect(ACTION_OUTCOME_TEXT[outcome]).toBeString();
    }
    expect(ACTION_PAYLOAD_RE.exec('bh1:AbC_-12345z')?.[1]).toBe('AbC_-12345z');
    expect(ACTION_PAYLOAD_RE.test('bh1:short')).toBe(false);
    expect(ACTION_PAYLOAD_RE.test('bh2:AbC_-12345z')).toBe(false);
  });
});

describe('deliveryReasonText', () => {
  it('explains every suppression reason and the dynamic ones', () => {
    for (const reason of SUPPRESSION_REASONS) {
      expect(deliveryReasonText(reason)).not.toBe(reason);
    }
    expect(deliveryReasonText('backlog:12')).toContain('12');
    expect(deliveryReasonText(null)).toBeNull();
    expect(deliveryReasonText('something-new')).toBe('something-new');
  });
});

describe('zPublicUrl', () => {
  it('accepts http(s) with a path prefix and drops trailing slashes', () => {
    expect(zPublicUrl.parse('https://bh.example.net/')).toBe('https://bh.example.net');
    expect(zPublicUrl.parse(' http://my-box.tail1234.ts.net:9876/bh// ')).toBe(
      'http://my-box.tail1234.ts.net:9876/bh',
    );
  });

  it('refuses queries, fragments, credentials and other schemes', () => {
    for (const bad of [
      'https://x.net/?a=1',
      'https://x.net/#f',
      'https://user:pw@x.net',
      'ftp://x.net',
      'x.net',
    ]) {
      expect(zPublicUrl.safeParse(bad).success).toBe(false);
    }
  });
});

describe('channel DTOs', () => {
  it('defaults target, secret refs and rules on input', () => {
    const parsed = ChannelInput.parse({ name: 'phone', kind: 'ntfy' });
    expect(parsed).toEqual({ name: 'phone', kind: 'ntfy', target: {}, secret_refs: {}, rules: {} });
  });

  it('previews either a saved channel or a draft', () => {
    expect(ChannelPreviewRequest.safeParse({ kind: 'telegram' }).success).toBe(true);
    expect(ChannelPreviewRequest.safeParse({ channel_id: 'nc-abcdef' }).success).toBe(true);
    expect(ChannelPreviewRequest.safeParse({}).success).toBe(false);
    expect(
      ChannelPreviewRequest.safeParse({ channel_id: 'nc-abcdef', kind: 'telegram' }).success,
    ).toBe(false);
  });
});
