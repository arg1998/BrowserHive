/** @module app/notifications/images.test — the per-channel screenshot rule (D-36): which variant a channel sees, and which variants a notification is captured with. */
import { describe, expect, it } from 'bun:test';
import type { Block, NotificationMessage } from '@browserhive/contracts/notifications';
import { applyImageRule, imageVariants, wantsImages } from './images.ts';
import { sampleMessage } from './samples.ts';

const image = (ref: string, masked: boolean): Block => ({
  type: 'image',
  ref,
  alt: 'page',
  captured_at: 1,
  masked,
  path: '/sessions/x',
});

function withImages(...blocks: Block[]): NotificationMessage {
  const base = sampleMessage('attention');
  return {
    ...base,
    blocks: [...base.blocks, ...blocks],
    privacy: { level: 'full', has_image: true },
  };
}

const refs = (m: NotificationMessage) =>
  m.blocks.flatMap((b) => (b.type === 'image' ? [b.ref] : []));

describe('applyImageRule', () => {
  const both = withImages(image('nimg-plain', false), image('nimg-mask', true));

  it('drops every image unless the category is on at level full', () => {
    expect(refs(applyImageRule(both, {}))).toEqual([]);
    expect(refs(applyImageRule(both, { images: { 'needs-you': true } }))).toEqual([]);
    expect(refs(applyImageRule(both, { content: 'full', images: { problems: true } }))).toEqual([]);
    expect(applyImageRule(both, {}).privacy.has_image).toBe(false);
  });

  it('gives a masking channel the masked variant only, others the unmasked one', () => {
    const on = { content: 'full', images: { 'needs-you': true } } as const;
    expect(refs(applyImageRule(both, { ...on, mask_images: true }))).toEqual(['nimg-mask']);
    expect(refs(applyImageRule(both, on))).toEqual(['nimg-plain']);
    expect(applyImageRule(both, on).privacy.has_image).toBe(true);
  });

  it('a non-masking channel falls back to the masked frame; a masking one never sees an unmasked frame', () => {
    const on = { content: 'full', images: { 'needs-you': true } } as const;
    expect(refs(applyImageRule(withImages(image('nimg-mask', true)), on))).toEqual(['nimg-mask']);
    expect(
      refs(applyImageRule(withImages(image('nimg-plain', false)), { ...on, mask_images: true })),
    ).toEqual([]);
  });

  it('leaves a message without images untouched', () => {
    const plain = sampleMessage('tool-errors');
    expect(applyImageRule(plain, {})).toBe(plain);
  });
});

describe('imageVariants', () => {
  it('asks for a masked capture when a wanting channel masks, unmasked when one does not', () => {
    const on = { content: 'full' as const, images: { 'needs-you': true } };
    expect(imageVariants([], 'needs-you')).toEqual({ masked: false, unmasked: false });
    expect(
      imageVariants(
        [
          { status: 'active', rules: { ...on, mask_images: true } },
          { status: 'active', rules: on },
        ],
        'needs-you',
      ),
    ).toEqual({ masked: true, unmasked: true });
    expect(imageVariants([{ status: 'paused', rules: on }], 'needs-you')).toEqual({
      masked: false,
      unmasked: false,
    });
    expect(imageVariants([{ status: 'active', rules: on }], 'problems')).toEqual({
      masked: false,
      unmasked: false,
    });
    expect(wantsImages({ images: { 'needs-you': true } }, 'needs-you')).toBe(false);
  });
});
