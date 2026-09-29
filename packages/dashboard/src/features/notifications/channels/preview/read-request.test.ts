/** @module features/notifications/channels/preview/read-request.test — the request readers for act buttons: a Telegram Rich Message (html from `rich_message`, no separate photo, styled keys), Discord interactive button styles, ntfy `http` actions (D-40, D-41, D-42) */
import { describe, expect, it } from 'bun:test';
import type { PlatformRequest } from '@browserhive/contracts/http';
import { readDiscord, readNtfy, readTelegram } from './read-request.ts';

function request(overrides: Partial<PlatformRequest>): PlatformRequest {
  return {
    method: 'POST',
    path: '/sendMessage',
    encoding: 'json',
    body: {},
    headers: {},
    file: null,
    ...overrides,
  } as PlatformRequest;
}

describe('readTelegram', () => {
  it('reads a Rich Message with its inline screenshot and styled buttons', () => {
    const view = readTelegram(
      request({
        path: '/sendRichMessage',
        encoding: 'multipart',
        file: { name: 'shot.jpg', content_type: 'image/jpeg' },
        body: {
          rich_message: JSON.stringify({
            html: '<h3>Attention</h3><img src="tg://photo?id=shot"/>',
            media: [{ id: 'shot', media: { type: 'photo', media: 'attach://shot' } }],
          }),
          reply_markup: JSON.stringify({
            inline_keyboard: [
              [
                { text: 'Mark resolved', callback_data: 'bh1:aaaaaaaaaaa', style: 'success' },
                { text: 'Reject', callback_data: 'bh1:bbbbbbbbbbb', style: 'danger' },
              ],
              [{ text: 'Open', url: 'https://bh.example.net/a' }],
            ],
          }),
        },
      }),
    );
    expect(view.rich).toBe(true);
    expect(view.html).toContain('<h3>Attention</h3>');
    expect(view.photo).toBeNull();
    expect(view.rows.map((r) => r.map((b) => b.style))).toEqual([['success', 'danger'], ['link']]);
    expect(view.rows[0]?.[0]?.url).toBeNull();
  });

  it('keeps the classic photo message as it was', () => {
    const view = readTelegram(
      request({
        path: '/sendPhoto',
        encoding: 'multipart',
        file: { name: 'screenshot.jpg', content_type: 'image/jpeg' },
        body: { caption: '<b>Hi</b>', parse_mode: 'HTML' },
      }),
    );
    expect(view.rich).toBe(false);
    expect(view.photo).toEqual({ name: 'screenshot.jpg' });
  });
});

describe('readDiscord', () => {
  it('maps interactive button styles', () => {
    const view = readDiscord(
      request({
        path: '/channels/1/messages',
        body: {
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: 'Approve', custom_id: 'bh1:a' },
                { type: 2, style: 4, label: 'Reject', custom_id: 'bh1:b' },
                { type: 2, style: 5, label: 'Open', url: 'https://bh.example.net/a' },
              ],
            },
          ],
        },
      }),
    );
    expect(view.rows[0]?.map((b) => b.style)).toEqual(['success', 'danger', 'link']);
  });
});

describe('readNtfy', () => {
  it('keeps http actions apart from view actions', () => {
    const view = readNtfy(
      request({
        path: '/',
        body: {
          topic: 'bh-alerts',
          message: 'x',
          actions: [
            { action: 'http', label: 'Mark resolved', url: 'https://ntfy.sh/bh-reply-x' },
            { action: 'view', label: 'Open', url: 'https://bh.example.net/a' },
          ],
        },
      }),
    );
    expect(view.actions.map((a) => a.kind)).toEqual(['http', 'view']);
  });
});
