/** @module test/notifications/helpers — deliveries built from the preview samples through the real pipeline (content level, degrade), link builders and an in-memory screenshot reader for the adapter suites. */

import type { NotificationContentLevel } from '@browserhive/contracts/enums';
import type { PreviewSample } from '@browserhive/contracts/notifications';
import { restrictContent } from '../../src/app/notifications/content-level.ts';
import { degrade } from '../../src/app/notifications/degrade.ts';
import { SAMPLE_IMAGE_REF, sampleMessage } from '../../src/app/notifications/samples.ts';
import type {
  ChannelCapabilities,
  ChannelDelivery,
  LinkBuilder,
  NotificationImageReader,
  PlatformMessageRef,
} from '../../src/ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../src/ports/persistence/records.ts';

/** Links through a public address. */
export const PUBLIC_LINKS: LinkBuilder = {
  local: false,
  url: (path) => `https://bh.example.net${path}`,
};

/** Links to this computer (no `publicUrl`). */
export const LOCAL_LINKS: LinkBuilder = {
  local: true,
  url: (path) => `http://127.0.0.1:9876${path}`,
};

/** A few JPEG-looking bytes. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** Resolves only the sample screenshot ref. */
export const SAMPLE_IMAGES: NotificationImageReader = {
  read: async (ref) =>
    ref === SAMPLE_IMAGE_REF
      ? { bytes: JPEG, contentType: 'image/jpeg', filename: 'screenshot.jpg' }
      : null,
};

/** Options of {@link delivery}. */
export interface DeliveryOptions {
  readonly image?: 'none' | 'masked' | 'unmasked';
  readonly level?: NotificationContentLevel;
  readonly links?: LinkBuilder;
  readonly replyTo?: PlatformMessageRef | null;
}

/**
 * A delivery of a sample as the outbox would hand it to a channel with `capabilities`.
 *
 * @returns The delivery.
 */
export function delivery(
  sample: PreviewSample,
  capabilities: ChannelCapabilities,
  options: DeliveryOptions = {},
): ChannelDelivery {
  const message = sampleMessage(sample, { image: options.image ?? 'none' });
  return {
    message: degrade(restrictContent(message, options.level ?? 'full'), capabilities),
    links: options.links ?? PUBLIC_LINKS,
    replyTo: options.replyTo ?? null,
  };
}

/** A channel row of a real platform kind. */
export function platformRecord(
  kind: string,
  overrides: Partial<NotificationChannelRecord> = {},
): NotificationChannelRecord {
  return {
    channelId: 'nc-000000000009',
    name: `my-${kind}`,
    kind,
    mode: kind === 'discord' ? 'webhook' : null,
    source: 'db',
    status: 'active',
    target: {},
    secretRefs: {},
    rules: {},
    failureCount: 0,
    lastError: null,
    lastOkAt: null,
    lastFailureAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
