/** @module interface/http/problem.test — problem+json projection of every registry code, zod failures, 401/405/429 headers. */

import { describe, expect, it } from 'bun:test';
import { ERROR_CODES, ERROR_REGISTRY, ProblemDetails } from '@browserhive/contracts/errors';
import { z } from 'zod';
import { AppError } from '../../kernel/errors/app-error.ts';
import { problemFromError, toAppError } from './problem.ts';

const context = { instance: '/api/v1/x', requestId: 'req-1' };

describe('problem+json projection', () => {
  for (const code of ERROR_CODES) {
    it(`projects ${code}`, () => {
      // Details are opaque to the projection; an empty object stands in for every schema.
      const error = new AppError(code, {} as never);
      const problem = problemFromError(error, context);
      const spec = ERROR_REGISTRY[code];
      expect(ProblemDetails.parse(problem.body)).toEqual(problem.body);
      expect(problem.body.code).toBe(code);
      expect(problem.body.title).toBe(spec.title);
      expect(problem.body.type).toBe(`https://browserhive.ai/docs/errors#${code}`);
      expect(problem.body.instance).toBe('/api/v1/x');
      expect(problem.body.request_id).toBe('req-1');
      const expected = spec.httpStatus >= 400 && spec.httpStatus <= 599 ? spec.httpStatus : 500;
      expect(problem.status).toBe(expected);
      expect(problem.headers['content-type']).toBe('application/problem+json');
    });
  }

  it('maps CONFLICT to 409 with current_version', () => {
    const problem = problemFromError(new AppError('CONFLICT', { current_version: 3 }), context);
    expect(problem.status).toBe(409);
    expect(problem.body.details).toEqual({ current_version: 3 });
  });

  it('adds WWW-Authenticate on 401 and Retry-After on 429', () => {
    expect(
      problemFromError(new AppError('UNAUTHORIZED', {}), context).headers['www-authenticate'],
    ).toContain('Bearer');
    const limited = problemFromError(
      new AppError('RATE_LIMITED', { retry_after_ms: 1500 }),
      context,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('2');
  });

  it('adds Allow on 405', () => {
    const problem = problemFromError(new AppError('METHOD_NOT_ALLOWED', { allow: ['GET'] }), {
      ...context,
      allow: ['GET', 'HEAD'],
    });
    expect(problem.status).toBe(405);
    expect(problem.headers['allow']).toBe('GET, HEAD');
  });

  it('turns a ZodError into 400 VALIDATION_FAILED with field issues', () => {
    const parsed = z.object({ a: z.number() }).safeParse({ a: 'x' });
    if (parsed.success) throw new Error('expected failure');
    const problem = problemFromError(parsed.error, context);
    expect(problem.status).toBe(400);
    expect(problem.body.details).toEqual({
      issues: [{ path: 'a', message: expect.any(String), code: 'invalid_type' }],
    });
  });

  it('wraps unknown errors as INTERNAL_ERROR with the request id as ref and a generic message', () => {
    const error = toAppError(new Error('/secret/path exploded'), 'req-9');
    expect(error.code).toBe('INTERNAL_ERROR');
    const problem = problemFromError(new Error('/secret/path exploded'), {
      ...context,
      requestId: 'req-9',
    });
    expect(problem.status).toBe(500);
    expect(JSON.stringify(problem.body)).not.toContain('/secret/path');
    expect(problem.body.details).toEqual({ ref: 'req-9' });
  });
});
