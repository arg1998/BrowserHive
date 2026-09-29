/** @module app/notifications/images — the per-channel screenshot rule (D-36, spec 03 §9.5): which image variant, if any, a channel may see, and which variants a notification should be captured with. Pure. */

import type { NotificationCategory } from '@browserhive/contracts/enums';
import type {
  Block,
  NotificationChannelRules,
  NotificationMessage,
} from '@browserhive/contracts/notifications';
import { contentLevelOf } from './routing.ts';

type ImageBlock = Extract<Block, { type: 'image' }>;

/** Whether a channel wants screenshots for a category at all (and is allowed them: level `full`). */
export function wantsImages(
  rules: NotificationChannelRules,
  category: NotificationCategory,
): boolean {
  return rules.images?.[category] === true && contentLevelOf(rules) === 'full';
}

/**
 * Keeps, per channel, only the image the channel may see (D-36): none when `images[category]` is
 * off or the content level is below `full`; with `mask_images`, only a masked image; otherwise the
 * unmasked image, or the masked one when that is all there is. At most one image survives.
 *
 * @returns The message for this channel (unchanged when it has no image).
 */
export function applyImageRule(
  message: NotificationMessage,
  rules: NotificationChannelRules,
): NotificationMessage {
  const images = message.blocks.filter((b): b is ImageBlock => b.type === 'image');
  if (images.length === 0) return message;
  let keep: ImageBlock | undefined;
  if (wantsImages(rules, message.category)) {
    const masked = images.find((b) => b.masked);
    const unmasked = images.find((b) => !b.masked);
    keep = rules.mask_images === true ? masked : (unmasked ?? masked);
  }
  const blocks = message.blocks.filter((b) => b.type !== 'image' || b === keep);
  return { ...message, blocks, privacy: { ...message.privacy, has_image: keep !== undefined } };
}

/** Which variants a notification of `category` should be captured with. */
export interface ImageVariants {
  readonly masked: boolean;
  readonly unmasked: boolean;
}

/**
 * The variants the active channels want for a category: a masked capture when any wanting channel
 * masks, an unmasked one when any does not. Neither when no active channel wants screenshots.
 *
 * @returns The variants.
 */
export function imageVariants(
  channels: readonly { readonly status: string; readonly rules: NotificationChannelRules }[],
  category: NotificationCategory,
): ImageVariants {
  let masked = false;
  let unmasked = false;
  for (const channel of channels) {
    if (channel.status !== 'active' || !wantsImages(channel.rules, category)) continue;
    if (channel.rules.mask_images === true) masked = true;
    else unmasked = true;
  }
  return { masked, unmasked };
}
