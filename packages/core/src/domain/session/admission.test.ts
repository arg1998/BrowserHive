/** @module domain/session/admission.test — derived cap, unbounded policy, typed retryable SESSION_LIMIT_REACHED. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  assertAdmitted,
  CapAdmissionPolicy,
  defaultAdmissionPolicy,
  deriveSessionCap,
} from './admission.ts';

const GIB = 1024 ** 3;
const request = (occupied: number) => ({ occupied, slug: 'shop', principal: 'local' });

describe('deriveSessionCap', () => {
  it('is max(1, min(floor(GiB / 1.5), 20))', () => {
    expect(deriveSessionCap(1 * GIB)).toBe(1);
    expect(deriveSessionCap(2 * GIB)).toBe(1);
    expect(deriveSessionCap(4 * GIB)).toBe(2);
    expect(deriveSessionCap(8 * GIB)).toBe(5);
    expect(deriveSessionCap(12 * GIB)).toBe(8);
    expect(deriveSessionCap(64 * GIB)).toBe(20);
    expect(deriveSessionCap(0)).toBe(1);
  });
});

describe('CapAdmissionPolicy', () => {
  it('admits below the cap and refuses at it', () => {
    const policy = new CapAdmissionPolicy(2);
    expect(policy.capacity()).toBe(2);
    expect(policy.admit(request(0)).ok).toBe(true);
    expect(policy.admit(request(1)).ok).toBe(true);
    const refused = policy.admit(request(2));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toEqual({ limit: 2, live: 2 });
  });

  it("'unbounded' reports null capacity and always admits", () => {
    const policy = new CapAdmissionPolicy('unbounded');
    expect(policy.capacity()).toBeNull();
    expect(policy.admit(request(10_000)).ok).toBe(true);
  });

  it('defaultAdmissionPolicy derives from host memory or takes the explicit value', () => {
    expect(defaultAdmissionPolicy({ totalMemoryBytes: 8 * GIB }).capacity()).toBe(5);
    expect(defaultAdmissionPolicy({ maxSessions: 3 }).capacity()).toBe(3);
    expect(defaultAdmissionPolicy({ maxSessions: 'unbounded' }).capacity()).toBeNull();
  });
});

describe('assertAdmitted', () => {
  it('throws the typed, retryable SESSION_LIMIT_REACHED with its registry message', () => {
    const policy = new CapAdmissionPolicy(3);
    expect(() => assertAdmitted(policy, request(2))).not.toThrow();
    try {
      assertAdmitted(policy, request(3));
      throw new Error('expected a throw');
    } catch (err) {
      expect(isAppError(err, 'SESSION_LIMIT_REACHED')).toBe(true);
      if (!isAppError(err, 'SESSION_LIMIT_REACHED')) return;
      expect(err.retryable).toBe('backoff');
      expect(err.details).toEqual({ limit: 3, live: 3 });
      expect(err.publicMessage).toBe(
        'Concurrent session limit reached (max=3). Close a session and retry.',
      );
      expect(err.message).toBe(err.publicMessage);
    }
  });
});
