/** @module contracts/test/tools/attention.test — dynamic description and outcome shape */
/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import {
  AttentionOutcome,
  REQUEST_ATTENTION,
  requestAttentionDescription,
  requestAttentionFloorNote,
} from '../../src/tools/attention.ts';

describe('request_attention description', () => {
  it('uses only the indefinite-wait sentence at floor 0', () => {
    expect(requestAttentionFloorNote(0)).toBe(
      'Set max_wait_seconds to 0 to wait indefinitely (up to the server limit), which is best when a human may be away.',
    );
    expect(REQUEST_ATTENTION.description).toBe(requestAttentionDescription(0));
    expect(REQUEST_ATTENTION.description).toContain(
      'Returns the operator decision { status, message?, resolved_by?, resolved_at, request_id }. http transport only.',
    );
  });

  it('injects the operator floor at 1800s (floored, clamped at 0)', () => {
    expect(requestAttentionFloorNote(1800)).toBe(
      'The operator requires a minimum wait of 1800s — a smaller max_wait_seconds is automatically raised to it, so give a human enough time. Set max_wait_seconds to 0 to wait indefinitely (up to the server limit), which is best when a human may be away.',
    );
    expect(requestAttentionFloorNote(1800.9)).toContain('minimum wait of 1800s');
    expect(requestAttentionFloorNote(-5)).toBe(requestAttentionFloorNote(0));
  });

  it('defaults mode=takeover and keeps options opaque', () => {
    expect(REQUEST_ATTENTION.input.parse({ session_id: 's', reason: 'captcha' })).toEqual({
      session_id: 's',
      reason: 'captcha',
      mode: 'takeover',
    });
    expect(
      REQUEST_ATTENTION.input.parse({ session_id: 's', reason: 'x', options: { a: [1] } }).options,
    ).toEqual({ a: [1] });
    expect(REQUEST_ATTENTION.input.safeParse({ session_id: 's', reason: '' }).success).toBe(false);
    expect(
      REQUEST_ATTENTION.input.safeParse({ session_id: 's', reason: 'x', max_wait_seconds: -1 })
        .success,
    ).toBe(false);
  });
});

describe('attention outcome', () => {
  it('omits message/resolved_by when absent and never reports pending', () => {
    expect(
      AttentionOutcome.parse({ status: 'timeout', resolved_at: 1, request_id: 'a-x' }),
    ).toEqual({
      status: 'timeout',
      resolved_at: 1,
      request_id: 'a-x',
    });
    expect(
      AttentionOutcome.safeParse({ status: 'pending', resolved_at: null, request_id: 'a-x' })
        .success,
    ).toBe(false);
  });
});
