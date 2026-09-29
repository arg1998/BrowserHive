/** @module app/notifications/samples.test — every preview sample is a valid contract message built by the real producers (spec 03 §4.8.1). */
import { describe, expect, it } from 'bun:test';
import { NotificationMessage, PREVIEW_SAMPLES } from '@browserhive/contracts/notifications';
import { SAMPLE_IMAGE_REF, sampleMessage } from './samples.ts';

describe('sampleMessage', () => {
  it('builds a valid message for every sample, with and without a screenshot', () => {
    for (const sample of PREVIEW_SAMPLES) {
      for (const image of ['none', 'masked', 'unmasked'] as const) {
        const message = sampleMessage(sample, { image });
        expect(NotificationMessage.safeParse(message).success).toBe(true);
      }
    }
  });

  it('carries the image only where a trigger exists, masked as asked', () => {
    const masked = sampleMessage('attention', { image: 'masked' });
    const block = masked.blocks.find((b) => b.type === 'image');
    expect(block).toMatchObject({ type: 'image', ref: SAMPLE_IMAGE_REF, masked: true });
    expect(masked.privacy.has_image).toBe(true);
    expect(sampleMessage('tool-errors', { image: 'masked' }).privacy.has_image).toBe(false);
    expect(sampleMessage('attention').privacy.has_image).toBe(false);
  });

  it('models lifecycle and grouping like real notifications', () => {
    const open = sampleMessage('attention');
    expect(open).toMatchObject({ state: 'open', alert: true, revision: 1 });
    expect(open.actions.some((a) => a.kind === 'act')).toBe(true);
    const resolved = sampleMessage('attention-resolved');
    expect(resolved).toMatchObject({ state: 'resolved', alert: false, revision: 2 });
    expect(resolved.actions).toEqual([]);
    expect(sampleMessage('tool-errors').title).toContain('3 tool errors');
    expect(sampleMessage('test')).toMatchObject({ kind: 'test', category: 'system' });
    expect(sampleMessage('test').actions[0]).toMatchObject({ id: 'open-dashboard' });
  });

  it('is deterministic', () => {
    expect(sampleMessage('crash')).toEqual(sampleMessage('crash'));
    expect(sampleMessage('crash', { now: 5 }).at.created).toBe(5);
  });
});
