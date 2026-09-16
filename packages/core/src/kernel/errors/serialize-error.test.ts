/** @module kernel/errors/serialize-error.test — cause-chain serialization. */

import { describe, expect, it } from 'bun:test';
import { AppError } from './app-error.ts';
import { MAX_CAUSE_DEPTH, serializeError } from './serialize-error.ts';

describe('serializeError', () => {
  it('projects name, message and code of an AppError with details', () => {
    const error = new AppError('SESSION_NOT_FOUND', { session_id: 'shop-a1b2c3d4' });
    const out = serializeError(error);
    expect(out.name).toBe('AppError');
    expect(out.code).toBe('SESSION_NOT_FOUND');
    expect(out.details).toEqual({ session_id: 'shop-a1b2c3d4' });
    expect(out.stack).toBeUndefined();
  });

  it('includes the stack only when asked', () => {
    const out = serializeError(new Error('boom'), { includeStack: true });
    expect(typeof out.stack).toBe('string');
  });

  it('walks the cause chain up to the depth cap', () => {
    let error: Error = new Error('root');
    for (let i = 0; i < 12; i += 1) {
      error = new Error(`level ${i}`, { cause: error });
    }
    const out = serializeError(error);
    let depth = 0;
    let cursor = out;
    while (cursor.cause !== undefined) {
      cursor = cursor.cause;
      depth += 1;
    }
    // MAX_CAUSE_DEPTH real errors are kept; the next link is the `[truncated]` marker.
    expect(depth).toBe(MAX_CAUSE_DEPTH);
    expect(cursor.message).toBe('[truncated]');
  });

  it('wraps non-error values', () => {
    expect(serializeError('oops')).toEqual({ name: 'NonError', message: 'oops' });
    expect(serializeError(undefined).message).toBe('undefined');
    expect(serializeError({ a: 1 }).message).toBe('{"a":1}');
  });

  it('stops on a circular cause', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    const out = serializeError(a);
    expect(out.cause?.cause?.message).toBe('[circular]');
  });

  it('keeps a string code on plain errors', () => {
    const error = Object.assign(new Error('enoent'), { code: 'ENOENT' });
    expect(serializeError(error).code).toBe('ENOENT');
  });
});
