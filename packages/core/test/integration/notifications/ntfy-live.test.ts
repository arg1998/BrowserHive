/** @module test/integration/notifications/ntfy-live.test — the ntfy adapter against a real ntfy server (spec 09 §3.2): publish, read back, attachment upload, replace by sequence id, delete. Runs only when `BHDEV_NTFY_URL` points at a server (CI starts `binwiederhier/ntfy` in the `ntfy` job); skipped otherwise. */

import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createNtfyChannel, NTFY_CAPABILITIES } from '../../../src/infra/notifications/index.ts';
import { delivery, platformRecord, SAMPLE_IMAGES } from '../../notifications/helpers.ts';

const SERVER = process.env['BHDEV_NTFY_URL'];

interface NtfyEvent {
  readonly event: string;
  readonly sequence_id?: string;
  readonly title?: string;
  readonly message?: string;
  readonly priority?: number;
  readonly tags?: string[];
  readonly actions?: { label: string; url: string }[];
  readonly attachment?: { name: string; size: number; url: string };
}

async function poll(server: string, topic: string): Promise<NtfyEvent[]> {
  const response = await fetch(`${server}/${topic}/json?poll=1`);
  expect(response.status).toBe(200);
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as NtfyEvent);
}

describe.skipIf(SERVER === undefined)('ntfy adapter against a real server', () => {
  it('publishes, uploads, replaces by sequence id and deletes', async () => {
    const server = (SERVER ?? '').replace(/\/+$/, '');
    const topic = `bh-ci-${randomBytes(6).toString('hex')}`;
    const channel = createNtfyChannel(platformRecord('ntfy', { target: { server, topic } }), {
      token: null,
      topic: null,
      images: SAMPLE_IMAGES,
    });

    const { ref } = await channel.send(
      delivery('attention', NTFY_CAPABILITIES, { image: 'masked' }),
    );
    expect(ref['sequence_id']).toBe('n-sample000001');
    let events = await poll(server, topic);
    const first = events.find((e) => e.event === 'message');
    expect(first).toMatchObject({
      sequence_id: 'n-sample000001',
      title: 'Attention requested',
      priority: 4,
    });
    expect(first?.tags).toEqual(['warning']);
    expect(first?.attachment?.name).toBe('screenshot.jpg');
    expect(first?.actions?.map((a) => a.label)).toEqual(['Take over', 'Open in BrowserHive']);

    await channel.edit?.(ref, delivery('attention-resolved', NTFY_CAPABILITIES));
    events = await poll(server, topic);
    const replaced = events.filter(
      (e) => e.event === 'message' && e.sequence_id === 'n-sample000001',
    );
    expect(replaced).toHaveLength(2);
    expect(replaced.at(-1)?.message).toContain('Resolved by admin');
    expect(replaced.at(-1)?.priority).toBe(2);

    await channel.delete?.(ref);
    events = await poll(server, topic);
    expect(events.at(-1)).toMatchObject({ event: 'message_delete', sequence_id: 'n-sample000001' });
  });

  it('refuses a fourth action like ntfy does, by never sending more than three', async () => {
    const server = (SERVER ?? '').replace(/\/+$/, '');
    const topic = `bh-ci-${randomBytes(6).toString('hex')}`;
    const channel = createNtfyChannel(platformRecord('ntfy', { target: { server, topic } }), {
      token: null,
      topic: null,
      images: SAMPLE_IMAGES,
    });
    await channel.send(delivery('vault-confirm', NTFY_CAPABILITIES));
    const [event] = await poll(server, topic);
    expect(event?.title).toBe('Vault fill awaiting confirm');
    expect((event?.actions ?? []).length).toBeLessThanOrEqual(3);
  });
});
