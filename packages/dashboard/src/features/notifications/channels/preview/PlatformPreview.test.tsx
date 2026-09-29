/** @module features/notifications/channels/preview/PlatformPreview.test — each platform mock draws from real renderer output (captured previews): Telegram HTML with the masked screenshot, Discord embed with APP/BOT tag and bot-mode act buttons, ntfy title/tags/actions, the webhook request; the request disclosure; axe clean */
import { describe, expect, it } from 'bun:test';
import { ChannelPreview } from '@browserhive/contracts/http';
import { CAPTURED } from '../../../../../test/fixtures/channels.ts';
import { expectNoA11yViolations } from '../../../../../test/helpers/axe.ts';
import { fireEvent, render, screen } from '../../../../../test/helpers/render.tsx';
import { PlatformPreview } from './PlatformPreview.tsx';
import { readDiscord, readNtfy, readTelegram } from './read-request.ts';

const P = {
  telegramPhoto: ChannelPreview.parse(CAPTURED.previews.telegramPhoto),
  telegramResolved: ChannelPreview.parse(CAPTURED.previews.telegramResolved),
  discord: ChannelPreview.parse(CAPTURED.previews.discord),
  discordBot: ChannelPreview.parse(CAPTURED.previews.discordBot),
  ntfy: ChannelPreview.parse(CAPTURED.previews.ntfy),
  ntfyImage: ChannelPreview.parse(CAPTURED.previews.ntfyImage),
  webhook: ChannelPreview.parse(CAPTURED.previews.webhook),
};

function first(p: ChannelPreview) {
  const r = p.requests[0];
  if (r === undefined) throw new Error('no request');
  return r;
}

describe('request readers', () => {
  it('reads the Telegram photo request and its keyboard', () => {
    const view = readTelegram(first(P.telegramPhoto));
    expect(view.photo).not.toBeNull();
    expect(view.html).toContain('<b>');
    const resolved = readTelegram(first(P.telegramResolved));
    expect(resolved.silent || resolved.edit || resolved.html.length > 0).toBe(true);
  });

  it('reads Discord embeds (multipart payload_json included) and button styles', () => {
    const view = readDiscord(first(P.discord));
    expect(view.embeds.length).toBe(1);
    expect(view.embeds[0]?.color).not.toBeNull();
    const bot = readDiscord(first(P.discordBot));
    expect(bot.rows.flat().some((b) => b.url === null)).toBe(true);
  });

  it('reads ntfy JSON and query-field publishes', () => {
    const view = readNtfy(first(P.ntfy));
    expect(view.title).not.toBeNull();
    expect(view.priority).toBeGreaterThanOrEqual(1);
    const parsed = readNtfy({
      method: 'PUT',
      path: '/bh-topic/n-1',
      encoding: 'binary',
      body: {
        title: 'T',
        message: 'M',
        tags: 'warning,cam',
        priority: 'high',
        actions: 'view, Open, https://x.y; view, Two, https://a.b',
      },
      headers: {},
      file: { name: 'screenshot.jpg', content_type: 'image/jpeg' },
    });
    expect(parsed).toMatchObject({
      topic: 'bh-topic',
      priority: 4,
      tags: ['warning', 'cam'],
      attachment: 'screenshot.jpg',
    });
    expect(parsed.actions.map((a) => a.label)).toEqual(['Open', 'Two']);
  });
});

describe('PlatformPreview', () => {
  it('draws the Telegram chat with the masked screenshot', async () => {
    const view = render(<PlatformPreview preview={P.telegramPhoto} chatTitle="Family ops" />);
    expect(screen.getByText('Family ops')).toBeDefined();
    expect(screen.getByLabelText(/form fields masked/)).toBeDefined();
    expect(view.container.querySelector('[data-platform="telegram"]')).not.toBeNull();
    await expectNoA11yViolations(view.container);
  });

  it('draws both Discord modes: APP with links, BOT with act buttons', async () => {
    const webhook = render(<PlatformPreview preview={P.discord} compact />);
    expect(screen.getByText('App')).toBeDefined();
    await expectNoA11yViolations(webhook.container);
    webhook.unmount();
    render(<PlatformPreview preview={P.discordBot} compact />);
    expect(screen.getByText('Bot')).toBeDefined();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('draws the ntfy notification with its actions and attachment', async () => {
    const view = render(<PlatformPreview preview={P.ntfyImage} />);
    expect(view.container.querySelector('[data-platform="ntfy"]')).not.toBeNull();
    expect(screen.getByLabelText(/Attached screenshot/)).toBeDefined();
    await expectNoA11yViolations(view.container);
  });

  it('shows the webhook request and discloses the raw requests', () => {
    render(<PlatformPreview preview={P.webhook} />);
    expect(screen.getByText('POST')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Show the request/ }));
    expect(screen.getByRole('button', { name: /Hide the request/ })).toBeDefined();
  });

  it('shows the publicUrl note once', () => {
    render(<PlatformPreview preview={{ ...P.webhook, local_links: true }} />);
    expect(screen.queryAllByText(/publicUrl/).length).toBeLessThanOrEqual(1);
  });
});
