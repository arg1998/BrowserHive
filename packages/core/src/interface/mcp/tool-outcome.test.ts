/** @module interface/mcp/tool-outcome.test — soft-failure audit codes for every returned-failure case. */

import { describe, expect, it } from 'bun:test';
import { classifyToolOutcome } from './tool-outcome.ts';

describe('classifyToolOutcome', () => {
  it('vault_fill statuses', () => {
    expect(classifyToolOutcome('vault_fill', { status: 'success', redacted: true })).toBeNull();
    expect(classifyToolOutcome('vault_fill', { status: 'origin_mismatch' })?.code).toBe(
      'ORIGIN_MISMATCH',
    );
    expect(
      classifyToolOutcome('vault_fill', { status: 'auth_failed', reason: 'fill_failed' }),
    ).toEqual({
      code: 'VAULT_FILL_AUTH_FAILED',
      message:
        'vault_fill did not complete: the credential could not be fetched or entered (fill_failed).',
    });
    expect(classifyToolOutcome('vault_fill', { status: 'blocked' })?.code).toBe(
      'VAULT_FILL_BLOCKED',
    );
  });

  it('vault_list_available rejected scope only', () => {
    expect(classifyToolOutcome('vault_list_available', { scope: 'no_page' })).toBeNull();
    expect(
      classifyToolOutcome('vault_list_available', {
        scope: 'rejected',
        mismatch: { declared: 'a.com', actual: null },
      })?.message,
    ).toContain("session is on 'no page loaded'");
  });

  it('attention statuses', () => {
    expect(classifyToolOutcome('request_attention', { status: 'resolved' })).toBeNull();
    expect(classifyToolOutcome('get_attention_result', { status: 'timeout' })?.code).toBe(
      'ATTENTION_TIMEOUT',
    );
    expect(
      classifyToolOutcome('request_attention', { status: 'cancelled', message: 'bye' })?.message,
    ).toBe('The attention request was cancelled before it was decided. Operator note: bye');
    expect(classifyToolOutcome('request_attention', { status: 'rejected' })?.code).toBe(
      'ATTENTION_REJECTED',
    );
  });

  it('navigate HTTP 4xx/5xx', () => {
    expect(classifyToolOutcome('navigate', { status: 200 })).toBeNull();
    expect(classifyToolOutcome('navigate', { status: null })).toBeNull();
    expect(classifyToolOutcome('navigate', { status: 503, url: 'http://x/' })?.code).toBe(
      'HTTP_503',
    );
    expect(classifyToolOutcome('click', { status: 500 })).toBeNull();
    expect(classifyToolOutcome('navigate', [1])).toBeNull();
  });
});
