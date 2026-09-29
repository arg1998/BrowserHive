/** @module test/notifications/render.golden.test — renderer golden files per platform × sample × variant (spec 09 §3.2): the realistic pipeline `degrade(restrictContent(sample, level), capabilities)` → `render`. `UPDATE_GOLDENS=1` blesses. */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NotificationContentLevel } from '@browserhive/contracts/enums';
import { PREVIEW_SAMPLES, type PreviewSample } from '@browserhive/contracts/notifications';
import { CHANNEL_RENDERERS } from '../../src/infra/notifications/index.ts';
import type {
  LinkBuilder,
  PlatformMessageRef,
  RenderContext,
} from '../../src/ports/notification-channel.ts';
import { delivery, LOCAL_LINKS, PUBLIC_LINKS } from './helpers.ts';

const GOLDEN_DIR = join(import.meta.dir, '..', 'goldens', 'notifications');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

const TARGETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  telegram: { chat_id: '-1001234567890' },
  discord: {},
  ntfy: { server: 'https://ntfy.example.net', topic: 'bh-alerts' },
  webhook: { url: 'https://hooks.example.net/bh' },
};

const EDIT_REFS: Readonly<Record<string, PlatformMessageRef>> = {
  telegram: { chat_id: -1001234567890, message_id: 101, photo: 0 },
  discord: { message_id: '1101', channel_id: '42' },
  ntfy: { id: 'm1', sequence_id: 'n-sample000001' },
  webhook: { notification_id: 'n-sample000001', revision: 1 },
};

const IMAGE_EDIT_REFS: Readonly<Record<string, PlatformMessageRef>> = {
  ...EDIT_REFS,
  telegram: { chat_id: -1001234567890, message_id: 101, photo: 1 },
  discord: {
    message_id: '1101',
    channel_id: '42',
    attachment_id: '9001101',
    attachment_name: 'screenshot.jpg',
  },
};

interface Variant {
  readonly name: string;
  readonly sample: PreviewSample;
  readonly image?: 'masked';
  readonly links?: LinkBuilder;
  readonly level?: NotificationContentLevel;
  readonly mode?: string;
  readonly edit?: boolean;
}

function variants(kind: string): Variant[] {
  const out: Variant[] = PREVIEW_SAMPLES.map((sample) => ({ name: sample, sample }));
  out.push(
    { name: 'attention-image', sample: 'attention', image: 'masked' },
    { name: 'attention-local', sample: 'attention', links: LOCAL_LINKS },
    { name: 'test-local', sample: 'test', links: LOCAL_LINKS },
    { name: 'attention-counts', sample: 'attention', level: 'counts' },
    { name: 'attention-resolved-edit', sample: 'attention-resolved', edit: true },
    {
      name: 'attention-resolved-image-edit',
      sample: 'attention-resolved',
      image: 'masked',
      edit: true,
    },
  );
  if (kind === 'discord') out.push({ name: 'attention-bot', sample: 'attention', mode: 'bot' });
  return out;
}

describe('renderer goldens', () => {
  for (const [kind, renderer] of CHANNEL_RENDERERS) {
    for (const v of variants(kind)) {
      it(`${kind} ${v.name}`, () => {
        const mode = v.mode ?? (kind === 'discord' ? 'webhook' : null);
        const capabilities = renderer.capabilities(mode);
        const d = delivery(v.sample, capabilities, {
          ...(v.image !== undefined && { image: v.image }),
          links: v.links ?? PUBLIC_LINKS,
          ...(v.level !== undefined && { level: v.level }),
        });
        const context: RenderContext = {
          mode,
          target: TARGETS[kind] ?? {},
          op: v.edit === true ? 'edit' : 'send',
          ref:
            v.edit === true
              ? ((v.image === undefined ? EDIT_REFS : IMAGE_EDIT_REFS)[kind] ?? null)
              : null,
          actToken: () => 'bh1:preview',
        };
        const body = { kind, variant: v.name, mode, requests: renderer.render(d, context) };
        const dir = join(GOLDEN_DIR, kind);
        const file = join(dir, `${v.name}.json`);
        if (UPDATE || !existsSync(file)) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
        }
        expect(JSON.parse(JSON.stringify(body))).toEqual(JSON.parse(readFileSync(file, 'utf8')));
      });
    }
  }
});
