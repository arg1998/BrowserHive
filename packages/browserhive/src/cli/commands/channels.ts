/** @module cli/commands/channels — `browserhive channels list | test <name> | preview <name>`: notification channels over a running server's REST API (spec 08 §7.1, spec 03 §4.8.1) */
import {
  ChannelPreview,
  ChannelsResponse,
  ChannelTestResponse,
  type ChannelView,
} from '@browserhive/contracts/http';
import { deliveryReasonText, type PreviewSample } from '@browserhive/contracts/notifications';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type RemoteTarget } from '../invocation.ts';
import { remoteCall } from './admin-remote.ts';
import { formatTimestamp } from './common.ts';

async function listChannels(
  context: CommandContext,
  remote: RemoteTarget,
): Promise<readonly ChannelView[] | ExitCode> {
  const result = await remoteCall(context, remote, 'GET', '/channels');
  if (!result.ok) return result.code;
  const parsed = ChannelsResponse.safeParse(result.json);
  if (!parsed.success) {
    context.out.diagnostic('browserhive: the server answered with an unexpected channel list.');
    return EXIT.fatal;
  }
  return parsed.data.data;
}

async function channelByName(
  context: CommandContext,
  remote: RemoteTarget,
  name: string,
): Promise<ChannelView | ExitCode> {
  const channels = await listChannels(context, remote);
  if (typeof channels === 'number') return channels;
  const found = channels.find((c) => c.name === name);
  if (found !== undefined) return found;
  const names = channels.map((c) => c.name);
  context.out.diagnostic(
    `browserhive: no notification channel named '${name}'.${names.length === 0 ? ' No channels are configured.' : ` Channels: ${names.join(', ')}.`}`,
  );
  return EXIT.fatal;
}

function statusText(channel: ChannelView): string {
  const base = channel.status === 'active' && !channel.ready ? 'not ready' : channel.status;
  return channel.source === 'startup' ? `${base} (from startup)` : base;
}

/** Whether presses reach BrowserHive (act buttons on): the listener's state, or `—`. */
function answersText(channel: ChannelView): string {
  if (channel.rules.act_buttons !== true) return '—';
  const c = channel.connection;
  if (c === null) return channel.kind === 'webhook' ? 'via your receiver' : 'not listening';
  return c.state === 'offline' && c.detail !== null ? `offline (${c.detail})` : c.state;
}

/** A time in a zone: `Wed 30 Sep 09:00`. */
function inZone(at: number, zone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', options).formatToParts(at);
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`;
}

/** The scheduled reports of a channel (D-43, D-44), or `null` without any. */
export function reportsText(channel: ChannelView): string | null {
  const r = channel.reports;
  const parts: string[] = [];
  if (r.digest !== null) {
    const every = r.digest.every === 'week' ? `weekly ${r.digest.day ?? 'mon'}` : 'daily';
    parts.push(
      `${every} digest ${r.digest.at} → next ${inZone(r.digest.next_at, r.time_zone)} ${r.time_zone}`,
    );
  }
  if (r.anomaly !== null) {
    parts.push(
      r.anomaly.active.length === 0
        ? 'anomaly alerts on'
        : `something looks off: ${r.anomaly.active.map((a) => a.check.replace('_', ' ')).join(', ')}`,
    );
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function secretsText(channel: ChannelView): string {
  if (channel.secrets.length === 0) return '—';
  return channel.secrets.map((s) => `${s.env} ${s.set ? '✓' : '✗'}`).join(', ');
}

/**
 * `channels list`.
 *
 * @returns The exit code.
 */
export async function runChannelsList(
  context: CommandContext,
  remote: RemoteTarget,
  json: boolean,
): Promise<ExitCode> {
  const { out } = context;
  const channels = await listChannels(context, remote);
  if (typeof channels === 'number') return channels;
  if (json) {
    out.json(channels);
    return EXIT.ok;
  }
  if (channels.length === 0) {
    out.line(
      'No notification channels. Add one in the dashboard (Notifications → Channels) or start with --notificationChannel.',
    );
    return EXIT.ok;
  }
  out.table(
    [
      { header: 'NAME' },
      { header: 'PLATFORM' },
      { header: 'STATUS' },
      { header: 'SENDS TO' },
      { header: 'SECRETS' },
      { header: 'ANSWERS' },
      { header: 'LAST DELIVERY' },
      { header: '24H SENT/FAILED/SUPPRESSED' },
    ],
    channels.map((c) => [
      out.style.bold(c.name),
      c.mode === null ? c.kind : `${c.kind} (${c.mode})`,
      statusText(c),
      c.target_hint,
      secretsText(c),
      answersText(c),
      c.stats.last_delivery_at === null
        ? 'never'
        : `${formatTimestamp(c.stats.last_delivery_at)} ${c.stats.last_status ?? ''}`.trim(),
      `${c.stats.sent_24h}/${c.stats.failed_24h}/${c.stats.suppressed_24h}`,
    ]),
  );
  for (const c of channels) {
    const reports = reportsText(c);
    if (reports !== null) out.line(`  ${out.style.dim(`${c.name}:`)} ${reports}`);
    if (c.problem !== null) out.line(`  ${out.style.dim(`${c.name}:`)} ${c.problem}`);
  }
  return EXIT.ok;
}

/**
 * `channels test <name>`: a real test message; exit 0 when the platform accepted it.
 *
 * @returns The exit code.
 */
export async function runChannelsTest(
  context: CommandContext,
  remote: RemoteTarget,
  name: string,
  json: boolean,
): Promise<ExitCode> {
  const { out } = context;
  const channel = await channelByName(context, remote, name);
  if (typeof channel === 'number') return channel;
  const result = await remoteCall(context, remote, 'POST', `/channels/${channel.channel_id}/test`);
  if (!result.ok) return result.code;
  const parsed = ChannelTestResponse.safeParse(result.json);
  if (!parsed.success) {
    out.diagnostic('browserhive: the server answered with an unexpected test result.');
    return EXIT.fatal;
  }
  if (json) out.json(parsed.data);
  else if (parsed.data.ok) {
    const ms = parsed.data.delivery?.duration_ms;
    out.status(
      'ok',
      `test message sent to ${name}`,
      ms === null || ms === undefined ? undefined : `${ms} ms`,
    );
  } else {
    const error = parsed.data.error;
    out.status('fail', `test message to ${name} failed`, error?.code);
    if (error !== null) {
      out.line(`  ${error.message}`);
      const why = deliveryReasonText(error.code);
      if (why !== null && why !== error.code) out.line(`  ${why}`);
    }
  }
  return parsed.data.ok ? EXIT.ok : EXIT.fatal;
}

/**
 * `channels preview <name> [--sample]`: the platform request a send would make; sends nothing.
 *
 * @returns The exit code.
 */
export async function runChannelsPreview(
  context: CommandContext,
  remote: RemoteTarget,
  name: string,
  sample: PreviewSample,
  json: boolean,
): Promise<ExitCode> {
  const { out } = context;
  const channel = await channelByName(context, remote, name);
  if (typeof channel === 'number') return channel;
  const result = await remoteCall(context, remote, 'POST', '/channels/preview', {
    channel_id: channel.channel_id,
    sample,
  });
  if (!result.ok) return result.code;
  const parsed = ChannelPreview.safeParse(result.json);
  if (!parsed.success) {
    out.diagnostic('browserhive: the server answered with an unexpected preview.');
    return EXIT.fatal;
  }
  const preview = parsed.data;
  if (json) {
    out.json(preview);
    return EXIT.ok;
  }
  out.line(
    out.style.bold(
      `${name} · ${preview.kind}${preview.mode === null ? '' : ` (${preview.mode})`} · sample ${sample}`,
    ),
  );
  out.line(out.style.dim('Nothing was sent. The request a send would make:'));
  for (const request of preview.requests) {
    out.line();
    out.line(`${request.method} ${request.path}  ${out.style.dim(request.encoding)}`);
    for (const [header, value] of Object.entries(request.headers)) out.line(`${header}: ${value}`);
    if (request.file !== null)
      out.line(out.style.dim(`[file ${request.file.name} ${request.file.content_type}]`));
    out.line(JSON.stringify(request.body, null, 2));
  }
  for (const note of preview.notes) out.line(`${out.style.dim('note:')} ${note}`);
  return EXIT.ok;
}
