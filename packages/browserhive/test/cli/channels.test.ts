/** @module test/cli/channels.test — `browserhive channels list` over the REST API (spec 08 §7.1): the platform with its Discord mode, the answer state of act buttons (D-41), and `--json`. */

import { describe, expect, it } from 'bun:test';
import type { ChannelView } from '@browserhive/contracts/http';
import type { CliDeps } from '../../src/cli/deps.ts';
import { cliHarness } from './helpers.ts';

function channel(overrides: Partial<ChannelView>): ChannelView {
  return {
    channel_id: 'nc-000000000001',
    name: 'phone',
    kind: 'telegram',
    mode: null,
    source: 'db',
    status: 'active',
    target: { chat_id: '-100123' },
    target_hint: 'Ops (…0123)',
    secret_refs: { token: 'BH_TG_TOKEN' },
    secrets: [{ param: 'token', env: 'BH_TG_TOKEN', set: true }],
    rules: {},
    capabilities: null,
    ready: true,
    problem: null,
    failure_count: 0,
    last_error: null,
    last_ok_at: null,
    last_failure_at: null,
    created_at: 1,
    updated_at: 1,
    stats: {
      sent_24h: 3,
      failed_24h: 0,
      suppressed_24h: 1,
      pending: 0,
      last_delivery_at: null,
      last_status: null,
    },
    connection: null,
    reports: { time_zone: 'Europe/Berlin', host_zone: true, digest: null, anomaly: null },
    ...overrides,
  };
}

const CHANNELS: ChannelView[] = [
  channel({
    rules: { act_buttons: true, allow_list: ['42'] },
    connection: { state: 'connected', since: 1, detail: null },
  }),
  channel({
    channel_id: 'nc-000000000002',
    name: 'ops-bot',
    kind: 'discord',
    mode: 'bot',
    target_hint: 'bot in #browserhive',
    rules: { act_buttons: true },
    connection: { state: 'offline', since: 1, detail: 'Discord refused the bot token.' },
  }),
  channel({ channel_id: 'nc-000000000003', name: 'pager', kind: 'ntfy', target_hint: 'ntfy.sh/x' }),
  channel({
    channel_id: 'nc-000000000004',
    name: 'morning',
    rules: { digest: { every: 'day', at: '08:30' }, anomaly: {}, time_zone: 'Europe/Berlin' },
    reports: {
      time_zone: 'Europe/Berlin',
      host_zone: false,
      // 2026-09-30 06:30 UTC = 08:30 in Berlin.
      digest: {
        every: 'day',
        at: '08:30',
        day: null,
        next_at: 1_790_749_800_000,
        last_until: null,
      },
      anomaly: {
        next_check_at: 1_790_748_000_000,
        active: [{ check: 'error_rate', since: 1, value: 34, threshold: 20 }],
      },
    },
  }),
];

const http: CliDeps['http'] = async () => {
  const body = { data: CHANNELS, now: 2, host_time_zone: 'Europe/Berlin' };
  return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

describe('channels list', () => {
  it('shows the Discord mode and whether presses reach BrowserHive', async () => {
    const result = await cliHarness({
      argv: ['channels', 'list', '--url', 'http://127.0.0.1:9876', '--token', 'bh_operator_x'],
      http,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ANSWERS');
    expect(result.stdout).toContain('discord (bot)');
    expect(result.stdout).toContain('connected');
    expect(result.stdout).toContain('offline (Discord refused the bot token.)');
    expect(result.stdout).toContain(
      'daily digest 08:30 → next Wed 30 Sep 08:30 Europe/Berlin · something looks off: error rate',
    );
    const json = await cliHarness({
      argv: ['channels', 'list', '--json', '--url', 'http://127.0.0.1:9876', '--token', 'x'],
      http,
    });
    expect((JSON.parse(json.stdout) as ChannelView[])[1]?.connection?.state).toBe('offline');
  });
});
