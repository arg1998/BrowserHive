/** @module features/notifications/channels/coverage.test — spec 04 principle 2 for the notification channel API: every channels / public-url operation is called through `useApi()` somewhere in the dashboard */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../../..');
const OPERATIONS = [
  'listChannels',
  'createChannel',
  'previewChannel',
  'listDeliveries',
  'getDelivery',
  'checkChannelEnv',
  'startTelegramConnect',
  'getTelegramConnect',
  'getChannel',
  'updateChannel',
  'deleteChannel',
  'pauseChannel',
  'resumeChannel',
  'testChannel',
  'getPublicUrlStatus',
  'getDiscordBot',
  'listDiscordChannels',
  'startDiscordConnect',
  'getDiscordConnect',
  'listChannelActions',
  'sendChannelDigest',
] as const;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('channel operations have a surface', () => {
  it('calls every operation through the typed client', () => {
    const text = sources(SRC)
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    for (const op of OPERATIONS) expect(text.includes(`api.${op}(`), op).toBe(true);
  });
});
