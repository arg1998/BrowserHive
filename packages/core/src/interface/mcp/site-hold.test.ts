/** @module interface/mcp/site-hold.test — a held live template session answers `SITE_OPERATOR_PENDING` for every tool but the exempt ones; exclusive and maintenance sessions are never held. */

import { describe, expect, it } from 'bun:test';
import type { Session } from '../../domain/session/session.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { assertNotSiteHeld, SITE_HOLD_EXEMPT_TOOLS, type SiteHolds } from './site-hold.ts';

const HOLDS: SiteHolds = {
  holdOf: (id) =>
    id === 'demo-00000001'
      ? { requestId: 'a-000000000001', site: 'site-a.test', reason: 'write_confirm' }
      : null,
};

function session(id: string, mode: 'live' | 'maintenance' | null = 'live'): Session {
  return {
    id,
    template: mode === null ? null : { templateId: 'tp-aaaaaaaaaa', mode },
  } as unknown as Session;
}

function refusal(tool: string, s: Session | null): unknown {
  try {
    assertNotSiteHeld(tool, s, HOLDS);
    return null;
  } catch (error) {
    return error;
  }
}

describe('assertNotSiteHeld', () => {
  it('answers SITE_OPERATOR_PENDING with the request to wait for', () => {
    const error = refusal('click', session('demo-00000001'));
    if (!isAppError(error)) throw new Error('not refused');
    expect(error.code).toBe('SITE_OPERATOR_PENDING');
    expect(error.details).toEqual({
      session_id: 'demo-00000001',
      site: 'site-a.test',
      request_id: 'a-000000000001',
      reason: 'write_confirm',
      wait_text: "Wait with get_attention_result('a-000000000001'), or close the session.",
    });
    expect(error.publicMessage).toBe(
      "site-a.test needs the operator before this session can continue (write_confirm). Wait with get_attention_result('a-000000000001'), or close the session.",
    );
  });

  it('lets the exempt tools through', () => {
    expect([...SITE_HOLD_EXEMPT_TOOLS].sort()).toEqual(
      [
        'close_session',
        'list_sessions',
        'server_status',
        'session_info',
        'list_tabs',
        'screenshot',
        'list_templates',
        'get_attention_result',
        'list_saved_auths',
        'vault_list_available',
      ].sort(),
    );
    for (const tool of SITE_HOLD_EXEMPT_TOOLS) {
      expect(refusal(tool, session('demo-00000001'))).toBeNull();
    }
  });

  it('never holds an unheld, exclusive or maintenance session, or a call without one', () => {
    expect(refusal('click', session('demo-00000002'))).toBeNull();
    expect(refusal('click', session('demo-00000001', null))).toBeNull();
    expect(refusal('click', session('demo-00000001', 'maintenance'))).toBeNull();
    expect(refusal('click', null)).toBeNull();
    expect(() => assertNotSiteHeld('click', session('demo-00000001'), undefined)).not.toThrow();
  });
});
