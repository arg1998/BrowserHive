/** @module app/config/notification-channel-flag.test — the `--notificationChannel` grammar (spec 08 §5.7, D-39): per-kind parameters, rules, env-name secrets, the exact exit-64 texts, and that a secret is never echoed. */
import { describe, expect, it } from 'bun:test';
import { parseNotificationChannelFlags } from './notification-channel-flag.ts';

const ENV: Record<string, string> = {
  BH_TG_TOKEN: `1234:${'a'.repeat(35)}`,
  BH_DISCORD_WEBHOOK: `https://discord.test/api/webhooks/1/${'b'.repeat(20)}`,
  BH_NTFY_TOKEN: `tk_${'c'.repeat(29)}`,
  BH_HOOK_SECRET: 'd'.repeat(32),
  BH_EMPTY: '',
  BH_DISCORD_BOT: 'e'.repeat(40),
  BH_NTFY_REPLY: 'bh-replies-x',
};
const env = (name: string) => ENV[name];
const parse = (...values: string[]) => parseNotificationChannelFlags(values, env);

describe('parseNotificationChannelFlags', () => {
  it('parses the four platforms of spec 08 §5.7', () => {
    const r = parse(
      'telegram:name=phone,token=env:BH_TG_TOKEN,chat=123456',
      'discord:name=team,webhook=env:BH_DISCORD_WEBHOOK,categories=needs-you+problems',
      'ntfy:name=pager,server=https://ntfy.example.net,topic=bh-alerts,token=env:BH_NTFY_TOKEN,min=error',
      'webhook:name=ops,url=https://hooks.example.net/bh,secret=env:BH_HOOK_SECRET',
    );
    expect(r.problems).toEqual([]);
    expect(r.channels).toEqual([
      {
        name: 'phone',
        kind: 'telegram',
        mode: null,
        target: { chat_id: '123456' },
        secret_refs: { token: 'BH_TG_TOKEN' },
        rules: {},
      },
      {
        name: 'team',
        kind: 'discord',
        mode: 'webhook',
        target: {},
        secret_refs: { webhook: 'BH_DISCORD_WEBHOOK' },
        rules: { categories: ['needs-you', 'problems'] },
      },
      {
        name: 'pager',
        kind: 'ntfy',
        mode: null,
        target: { server: 'https://ntfy.example.net', topic: 'bh-alerts' },
        secret_refs: { token: 'BH_NTFY_TOKEN' },
        rules: { min_severity: 'error' },
      },
      {
        name: 'ops',
        kind: 'webhook',
        mode: null,
        target: { url: 'https://hooks.example.net/bh' },
        secret_refs: { secret: 'BH_HOOK_SECRET' },
        rules: {},
      },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('parses every rule parameter', () => {
    const r = parse(
      'telegram:name=phone,token=env:BH_TG_TOKEN,chat=-1001234567890,thread=42,sessions=shop-*+scrape-*,harness=claude-code,content=full,quiet=22:00-07:30,tz=Europe/Berlin,ttl.needs-you=2h,ttl.problems=1d,deleteWhenResolved=needs-you,images=needs-you,maskImages=true',
    );
    expect(r.problems).toEqual([]);
    expect(r.channels[0]).toEqual({
      name: 'phone',
      kind: 'telegram',
      mode: null,
      target: { chat_id: '-1001234567890', thread_id: '42' },
      secret_refs: { token: 'BH_TG_TOKEN' },
      rules: {
        sessions: ['shop-*', 'scrape-*'],
        harness: ['claude-code'],
        content: 'full',
        quiet_hours: { start: '22:00', end: '07:30', time_zone: 'Europe/Berlin' },
        ttl_ms: { 'needs-you': 7_200_000, problems: 86_400_000 },
        delete_when_resolved: { 'needs-you': true },
        images: { 'needs-you': true },
        mask_images: true,
      },
    });
  });

  it('refuses an inline secret with the exact message and never echoes it', () => {
    const secret = `9876:${'z'.repeat(35)}`;
    const r = parse(`telegram:name=phone,token=${secret},chat=1`);
    expect(r.channels).toEqual([]);
    expect(r.problems).toEqual([
      "--notificationChannel 'phone': token must name an environment variable (token=env:NAME), never contain the secret: other users of this machine can read process arguments.",
    ]);
    expect(JSON.stringify(r)).not.toContain('zzzz');
  });

  it('names unset or empty variables and reserved prefixes', () => {
    expect(parse('telegram:name=a,token=env:BH_MISSING,chat=1').problems).toEqual([
      "--notificationChannel 'a': BH_MISSING is not set (token=env:BH_MISSING). Set it in the environment that starts BrowserHive.",
    ]);
    expect(parse('telegram:name=a,token=env:BH_EMPTY,chat=1').problems[0]).toContain(
      'BH_EMPTY is not set',
    );
    expect(parse('telegram:name=a,token=env:BROWSERHIVE_TG,chat=1').problems[0]).toContain(
      'reserved for configuration',
    );
  });

  it('reports unknown platforms and parameters with suggestions, and missing ones', () => {
    expect(parse('telegarm:name=a').problems[0]).toContain("Did you mean 'telegram:'?");
    expect(parse('telegram:name=a,token=env:BH_TG_TOKEN,chta=1').problems).toEqual([
      "--notificationChannel #1: unknown parameter 'chta' for Telegram. Did you mean 'chat'?",
      "--notificationChannel 'a': chat is required.",
    ]);
    expect(parse('ntfy:name=a').problems).toEqual([
      "--notificationChannel 'a': topic is required.",
    ]);
    expect(parse('telegram:token=env:BH_TG_TOKEN,chat=1').problems).toEqual([
      '--notificationChannel #1: name is required (name=phone).',
    ]);
  });

  it('caps Telegram TTLs at 47 h and validates rule values', () => {
    expect(
      parse('telegram:name=a,token=env:BH_TG_TOKEN,chat=1,ttl.needs-you=48h').problems[0],
    ).toContain('longer than 47h');
    expect(parse('ntfy:name=a,topic=t1,ttl.needs-you=3d').problems).toEqual([]);
    const bad = parse(
      'ntfy:name=a,topic=t1,min=loud,quiet=25:00-01:00,content=all,images=needs-you',
    );
    expect(bad.problems).toHaveLength(4);
    expect(parse('ntfy:name=a,topic=t1,images=needs-you').problems).toEqual([
      "--notificationChannel 'a': images needs content=full (screenshots are full content).",
    ]);
  });

  it('refuses duplicate names and repeated parameters', () => {
    expect(parse('ntfy:name=a,topic=t1', 'ntfy:name=a,topic=t2').problems[0]).toContain(
      "the name 'a' is used by two channels",
    );
    expect(parse('ntfy:name=a,topic=t1,topic=t2').problems[0]).toContain('given twice');
  });

  it('parses act buttons, allow-lists, Discord bot mode and the ntfy reply topic (D-41, D-42)', () => {
    const r = parse(
      'telegram:name=phone,token=env:BH_TG_TOKEN,chat=123456,actButtons=true,allow=111+222',
      'discord:name=ops,mode=bot,token=env:BH_DISCORD_BOT,channel=112233445566778899,guild=998877665544332211,actButtons=true,allow=445566778899001122',
      'ntfy:name=pager,topic=bh-alerts-x,reply=env:BH_NTFY_REPLY,replyToken=env:BH_NTFY_TOKEN,actButtons=true',
      'ntfy:name=pager2,topic=bh-alerts-y,reply=bh-replies-y',
    );
    expect(r.problems).toEqual([]);
    expect(r.channels.map((c) => [c.name, c.mode, c.target, c.secret_refs, c.rules])).toEqual([
      [
        'phone',
        null,
        { chat_id: '123456' },
        { token: 'BH_TG_TOKEN' },
        { act_buttons: true, allow_list: ['111', '222'] },
      ],
      [
        'ops',
        'bot',
        { channel_id: '112233445566778899', guild_id: '998877665544332211' },
        { token: 'BH_DISCORD_BOT' },
        { act_buttons: true, allow_list: ['445566778899001122'] },
      ],
      [
        'pager',
        null,
        { topic: 'bh-alerts-x' },
        { reply_topic: 'BH_NTFY_REPLY', reply_token: 'BH_NTFY_TOKEN' },
        { act_buttons: true },
      ],
      ['pager2', null, { topic: 'bh-alerts-y', reply_topic: 'bh-replies-y' }, {}, {}],
    ]);
  });

  it('refuses act buttons where presses cannot arrive, bad allow-lists and missing bot settings', () => {
    expect(parse('discord:name=a,webhook=env:BH_DISCORD_WEBHOOK,actButtons=true').problems).toEqual(
      [
        "--notificationChannel 'a': actButtons: act buttons need Discord bot mode; webhook messages can only carry links.",
      ],
    );
    expect(parse('ntfy:name=a,topic=t1,actButtons=true').problems[0]).toContain(
      'need a reply topic',
    );
    expect(parse('ntfy:name=a,topic=t1,reply=t2,allow=1').problems[0]).toContain(
      'allow: ntfy presses carry no user identity',
    );
    expect(parse('telegram:name=a,token=env:BH_TG_TOKEN,chat=1,allow=me').problems[0]).toContain(
      "allow: 'me' is not a user id",
    );
    expect(parse('discord:name=a,webhook=env:BH_DISCORD_WEBHOOK,mode=bot').problems).toEqual([
      "--notificationChannel 'a': channel is required in bot mode.",
      "--notificationChannel 'a': token is required in bot mode (token=env:NAME).",
    ]);
    expect(parse('ntfy:name=a,topic=t1,replyToken=tk_inline').problems[0]).toContain(
      'replyToken must name an environment variable (replyToken=env:NAME)',
    );
    expect(parse('telegram:name=a,token=env:BH_TG_TOKEN,chat=1,actButtons=maybe').problems).toEqual(
      ["--notificationChannel 'a': actButtons must be true or false."],
    );
  });

  it('warns about a literal topic on ntfy.sh and decodes percent-encoding', () => {
    const r = parse('ntfy:name=a,topic=bh-x', 'webhook:name=b,url=https://h.example.net/a%2Cb');
    expect(r.problems).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.channels[1]?.target['url']).toBe('https://h.example.net/a,b');
    expect(parse('ntfy:name=a,topic=env:BH_NTFY_TOKEN').channels[0]?.secret_refs).toEqual({
      topic: 'BH_NTFY_TOKEN',
    });
  });
});
