/** @module domain/vault/redaction.test — per-session redaction windows over the SecretRegistry */

import { describe, expect, it } from 'bun:test';
import { REDACTED, SecretRegistry } from '../../kernel/redact.ts';
import { VaultRedaction } from './redaction.ts';

function make(nowRef: { t: number }): { registry: SecretRegistry; mgr: VaultRedaction } {
  const registry = new SecretRegistry({ now: () => nowRef.t });
  const mgr = new VaultRedaction({ registry, windowMs: 5000, now: () => nowRef.t });
  return { registry, mgr };
}

describe('VaultRedaction', () => {
  it('scrubs an armed secret from a session response within the window', () => {
    const nowRef = { t: 1000 };
    const { mgr, registry } = make(nowRef);
    mgr.arm('s1', ['hunter2pass'], ['example.com']);
    expect(mgr.scrub('s1', 'the value is hunter2pass!')).toBe(`the value is ${REDACTED}!`);
    expect(registry.scrub('log hunter2pass line')).toBe(`log ${REDACTED} line`);
    expect(mgr.windowMillis).toBe(5000);
  });

  it('does not scrub a session without a window', () => {
    const nowRef = { t: 0 };
    const { mgr } = make(nowRef);
    mgr.arm('s1', ['secretpw'], ['example.com']);
    expect(mgr.scrub('s2', 'secretpw here')).toBe('secretpw here');
  });

  it('stops scrubbing after the window expires and releases the shared registry', () => {
    const nowRef = { t: 0 };
    const { mgr, registry } = make(nowRef);
    mgr.arm('s1', ['topsecret'], ['example.com']);
    nowRef.t = 6000;
    expect(mgr.scrub('s1', 'topsecret')).toBe('topsecret');
    expect(registry.scrub('topsecret')).toBe('topsecret');
    expect(mgr.isActive('s1')).toBe(false);
  });

  it('re-arming extends the deadline and unions the secrets', () => {
    const nowRef = { t: 0 };
    const { mgr } = make(nowRef);
    mgr.arm('s1', ['first-secret'], ['a.com']);
    nowRef.t = 4000;
    mgr.arm('s1', ['second-secret'], ['a.com']);
    nowRef.t = 8000;
    expect(mgr.scrub('s1', 'first-secret second-secret')).toBe(`${REDACTED} ${REDACTED}`);
  });

  it('closes the window on cross-origin navigation only', () => {
    const nowRef = { t: 0 };
    const { mgr } = make(nowRef);
    mgr.arm('s1', ['pwvalue'], ['example.com', '*.example.com']);
    mgr.onNavigation('s1', 'https://www.example.com/next');
    expect(mgr.isActive('s1')).toBe(true);
    mgr.onNavigation('s1', 'https://evil.com/');
    expect(mgr.isActive('s1')).toBe(false);
    expect(mgr.scrub('s1', 'pwvalue')).toBe('pwvalue');
  });

  it('ref-counts shared secrets across concurrent sessions', () => {
    const nowRef = { t: 0 };
    const { mgr, registry } = make(nowRef);
    mgr.arm('s1', ['shared-secret'], ['a.com']);
    mgr.arm('s2', ['shared-secret'], ['b.com']);
    mgr.close('s1');
    expect(registry.scrub('shared-secret')).toBe(REDACTED);
    mgr.close('s2');
    expect(registry.scrub('shared-secret')).toBe('shared-secret');
  });

  it('ignores too-short secrets and closeAll clears everything', () => {
    const nowRef = { t: 0 };
    const { mgr } = make(nowRef);
    mgr.arm('s1', ['ab'], ['a.com']);
    expect(mgr.isActive('s1')).toBe(false);
    mgr.arm('s2', ['long-enough'], ['a.com']);
    mgr.closeAll();
    expect(mgr.isActive('s2')).toBe(false);
  });
});
