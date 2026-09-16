/** @module lib/api/errors.test — a client TypeError is a dashboard bug, never "Network error" */
import { describe, expect, it } from 'bun:test';
import { AppError, clientError, networkError, toAppError } from './errors.ts';

describe('toAppError', () => {
  it('labels an uncaught TypeError as a client bug with its stack', () => {
    const error = toAppError(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(error.code).toBe('CLIENT_ERROR');
    expect(error.title).toBe('Something broke in the dashboard');
    expect(error.isClientBug).toBe(true);
    expect(error.isServerError).toBe(false);
    expect(typeof error.details['stack']).toBe('string');
  });

  it('keeps explicit transport errors and passes AppErrors through', () => {
    expect(networkError(new TypeError('fetch failed')).code).toBe('NETWORK_ERROR');
    const known = new AppError({
      code: 'NOT_FOUND',
      status: 404,
      title: 'Not found',
      retryable: 'never',
    });
    expect(toAppError(known)).toBe(known);
    expect(toAppError(new DOMException('stop', 'AbortError')).code).toBe('ABORTED');
    expect(clientError('boom').message).toBe('boom');
  });
});
