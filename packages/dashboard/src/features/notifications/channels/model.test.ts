/** @module features/notifications/channels/model.test — the pure channel logic: presets and summaries, TTL choices with the Telegram cap, draft defaults and problems, the API body, launch snippets, subscribe links and the private-address note */
import { describe, expect, it } from 'bun:test';
import { TELEGRAM_TTL_MAX_MS } from '@browserhive/contracts/notifications';
import {
  applyPreset,
  channelWhere,
  cleanRules,
  draftForKind,
  draftForMode,
  draftProblems,
  draftToInput,
  draftToPatch,
  EMPTY_DRAFT,
  envSnippet,
  isPrivateUrl,
  isPublicNtfy,
  ntfyLinks,
  presetOf,
  randomReplyTopic,
  randomTopic,
  rulesSummary,
  stepProblems,
  suggestName,
  ttlChoices,
} from './model.ts';

describe('presets', () => {
  it('maps categories to presets and back', () => {
    expect(presetOf({ categories: ['needs-you'] })).toBe('needs-me');
    expect(presetOf({ categories: ['problems', 'needs-you'] })).toBe('problems');
    expect(presetOf({})).toBe('everything');
    expect(presetOf({ categories: ['system'] })).toBeNull();
    expect(applyPreset({ min_severity: 'warn', categories: ['system'] }, 'everything')).toEqual({
      min_severity: 'warn',
    });
  });

  it('summarises rules in one line', () => {
    expect(
      rulesSummary({
        categories: ['needs-you', 'problems'],
        min_severity: 'error',
        quiet_hours: { start: '22:00', end: '07:00' },
        images: { 'needs-you': true },
        mask_images: true,
        ttl_ms: { 'needs-you': 7_200_000 },
      }),
    ).toBe('Problems · error and up · quiet 22:00–07:00 · masked screenshots · self-destruct 2 h');
    expect(rulesSummary({ categories: ['system', 'reports'] })).toBe('System, Reports');
  });
});

describe('TTL', () => {
  it('caps Telegram at 47 hours and offers days elsewhere', () => {
    const tg = ttlChoices('telegram').map((c) => c.value);
    expect(Math.max(...tg.filter((v): v is number => v !== null))).toBe(TELEGRAM_TTL_MAX_MS);
    expect(ttlChoices('ntfy').some((c) => c.value === 7 * 86_400_000)).toBe(true);
    expect(ttlChoices('discord')[0]).toEqual({ value: null, label: 'Never' });
  });

  it('refuses a Telegram TTL above 47 hours', () => {
    const draft = {
      ...draftForKind(EMPTY_DRAFT, 'telegram', []),
      target: { chat_id: '1' },
      rules: { ttl_ms: { 'needs-you': 48 * 3_600_000 } },
    };
    expect(draftProblems(draft).map((p) => p.field)).toEqual(['rules.ttl_ms.needs-you']);
  });
});

describe('drafts', () => {
  it('names the required secrets, fills ntfy defaults and suggests a free name', () => {
    const tg = draftForKind(EMPTY_DRAFT, 'telegram', ['phone']);
    expect(tg.secretRefs).toEqual({ token: 'BH_TELEGRAM_TOKEN' });
    expect(tg.name).toBe('phone-2');
    expect(tg.rules).toEqual({ categories: ['needs-you'] });
    const ntfy = draftForKind(EMPTY_DRAFT, 'ntfy', []);
    expect(ntfy.target['server']).toBe('https://ntfy.sh');
    expect(ntfy.target['topic']).toMatch(/^bh-[a-z2-9]{12}$/);
    expect(ntfy.name).toBe('push');
    expect(suggestName('discord', ['team', 'team-2'])).toBe('team-3');
  });

  it('reports problems per step', () => {
    const d = draftForKind(EMPTY_DRAFT, 'webhook', []);
    expect(stepProblems(d, 'credentials')).toEqual([]);
    expect(stepProblems(d, 'connect').map((p) => p.field)).toEqual(['target.url']);
    expect(stepProblems({ ...d, name: 'Bad Name' }, 'rules').map((p) => p.field)).toEqual(['name']);
    expect(stepProblems(EMPTY_DRAFT, 'platform').map((p) => p.field)).toEqual(['kind']);
  });

  it('builds the API bodies without empty rule keys', () => {
    const d = {
      ...draftForKind(EMPTY_DRAFT, 'discord', []),
      rules: { categories: ['needs-you' as const], sessions: [], images: { problems: false } },
    };
    expect(cleanRules(d.rules)).toEqual({ categories: ['needs-you'] });
    expect(draftToInput(d)).toEqual({
      name: 'team',
      kind: 'discord',
      mode: 'webhook',
      target: {},
      secret_refs: { webhook: 'BH_DISCORD_WEBHOOK' },
      rules: { categories: ['needs-you'] },
    });
    expect('kind' in draftToPatch(d)).toBe(false);
  });

  it('draws random topics from a readable alphabet', () => {
    expect(randomTopic(() => 0)).toBe('bh-aaaaaaaaaaaa');
  });
});

describe('snippets and links', () => {
  it('writes the lines for each launch method, never a value', () => {
    for (const method of ['shell', 'systemd', 'docker', 'config'] as const) {
      const text = envSnippet(method, ['BH_TELEGRAM_TOKEN']);
      expect(text).toContain('BH_TELEGRAM_TOKEN');
      expect(text).toContain('<paste the value here>');
    }
    expect(envSnippet('systemd', ['A'])).toContain('Environment="A=');
    expect(envSnippet('docker', ['A'])).toContain('-e A=');
  });

  it('builds ntfy subscribe links and spots ntfy.sh', () => {
    expect(ntfyLinks('https://ntfy.sh/', 'bh-x')).toEqual({
      web: 'https://ntfy.sh/bh-x',
      app: 'ntfy://ntfy.sh/bh-x',
    });
    expect(isPublicNtfy(undefined)).toBe(true);
    expect(isPublicNtfy('https://ntfy.example.net')).toBe(false);
  });

  it('recognises private webhook targets', () => {
    for (const url of [
      'http://192.168.1.5:8123/api/webhook/x',
      'http://localhost/x',
      'http://10.0.0.1',
    ]) {
      expect(isPrivateUrl(url)).toBe(true);
    }
    expect(isPrivateUrl('https://hooks.example.net/x')).toBe(false);
    expect(isPrivateUrl('not a url')).toBe(false);
  });
});

describe('act buttons and Discord modes', () => {
  const discord = draftForKind(EMPTY_DRAFT, 'discord', []);

  it("names only the current mode's variable and swaps it with the mode", () => {
    expect(discord.mode).toBe('webhook');
    expect(discord.secretRefs).toEqual({ webhook: 'BH_DISCORD_WEBHOOK' });
    const bot = draftForMode({ ...discord, rules: { ...discord.rules, act_buttons: true } }, 'bot');
    expect(bot.secretRefs).toEqual({ token: 'BH_DISCORD_BOT_TOKEN' });
    const withTarget = {
      ...bot,
      target: { channel_id: '1', channel_name: 'alerts', guild_id: '2', guild_name: 'Home' },
    };
    const back = draftForMode(withTarget, 'webhook');
    expect(back.secretRefs).toEqual({ webhook: 'BH_DISCORD_WEBHOOK' });
    expect(back.target).toEqual({});
    // Webhook messages cannot carry act buttons, so the switch goes off; the rest is kept.
    expect(back.rules.act_buttons).toBeUndefined();
    expect(back.rules.categories).toEqual(discord.rules.categories);
  });

  it('checks act buttons and the allow-list in the rules step', () => {
    const webhook = { ...discord, rules: { act_buttons: true, allow_list: ['12', 'me'] } };
    expect(stepProblems(webhook, 'rules').map((p) => p.field)).toEqual([
      'rules.act_buttons',
      'rules.allow_list',
    ]);
    const ntfy = draftForKind(EMPTY_DRAFT, 'ntfy', []);
    expect(
      stepProblems({ ...ntfy, rules: { act_buttons: true } }, 'rules').map((p) => p.field),
    ).toEqual(['rules.act_buttons']);
    expect(
      stepProblems(
        {
          ...ntfy,
          target: { ...ntfy.target, reply_topic: 'bh-reply-x' },
          rules: { act_buttons: true },
        },
        'rules',
      ),
    ).toEqual([]);
  });

  it('asks for the reply topic variable in Connect, not in Credentials', () => {
    const ntfy = draftForKind(EMPTY_DRAFT, 'ntfy', []);
    const draft = { ...ntfy, secretRefs: { ...ntfy.secretRefs, reply_topic: 'bad name' } };
    expect(stepProblems(draft, 'credentials')).toEqual([]);
    expect(stepProblems(draft, 'connect').map((p) => p.field)).toContain('secret_refs.reply_topic');
  });

  it('summarises act buttons and draws hard-to-guess reply topics', () => {
    expect(rulesSummary({ act_buttons: true })).toContain('answer from the chat');
    expect(randomReplyTopic(() => 0.5)).toMatch(/^bh-reply-[a-z0-9]{12}$/);
  });

  it('says where a channel sends', () => {
    const base = { kind: 'discord', mode: 'bot', target_hint: 'bot from $?' } as const;
    expect(
      channelWhere({
        ...base,
        target: { channel_id: '1', channel_name: 'alerts', guild_name: 'Home' },
      }),
    ).toBe('#alerts in Home');
    expect(channelWhere({ ...base, target: { channel_id: '1' } })).toBe('#1');
    expect(
      channelWhere({
        kind: 'discord',
        mode: 'webhook',
        target: {},
        target_hint: 'webhook from $BH_DISCORD_WEBHOOK',
      }),
    ).toBe('from $BH_DISCORD_WEBHOOK');
    expect(channelWhere({ kind: 'ntfy', mode: null, target: {}, target_hint: 'ntfy.sh/x' })).toBe(
      'ntfy.sh/x',
    );
  });
});
