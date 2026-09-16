/** @module interface/http/middleware/error-handler.test — 5xx failures are logged with the thrown error itself (the logger serializes it), the route and the problem ref. */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { CollectingLogger } from '../../../../test/helpers/collecting-logger.ts';
import type { HttpEnv } from '../env.ts';
import { errorHandler } from './error-handler.ts';

describe('errorHandler', () => {
  it('logs the thrown error itself with method, path, status and ref', async () => {
    const logger = new CollectingLogger();
    const thrown = new TypeError('kaboom');
    const app = new Hono<HttpEnv>();
    app.onError(errorHandler(logger));
    app.get('/boom', () => {
      throw thrown;
    });
    const res = await app.request('http://localhost/boom');
    expect(res.status).toBe(500);
    const body: unknown = await res.json();
    const record = logger.records.find((r) => r.msg === 'request failed');
    expect(record?.fields).toMatchObject({
      module: 'http',
      err: thrown,
      method: 'GET',
      path: '/boom',
      status: 500,
      ref: expect.any(String),
    });
    expect(body).toMatchObject({ details: { ref: record?.fields['ref'] } });
  });
});
