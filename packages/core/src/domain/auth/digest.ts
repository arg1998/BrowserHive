/** @module domain/auth/digest — SHA-256 at-rest form of tokens and constant-time comparison (spec 03 §3.2). */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Hex SHA-256 of a token literal; the only form stored in `credentials`, `auth_sessions`, `grants`. */
export function sha256Hex(literal: string): string {
  return createHash('sha256').update(literal, 'utf8').digest('hex');
}

/**
 * Constant-time equality of two strings. Length mismatch still compares a same-length buffer
 * so the timing does not reveal at which byte the inputs diverge.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** True when `literal` hashes to `storedHash` (constant-time on the hash). */
export function matchesHash(literal: string, storedHash: string): boolean {
  return constantTimeEqual(sha256Hex(literal), storedHash);
}
