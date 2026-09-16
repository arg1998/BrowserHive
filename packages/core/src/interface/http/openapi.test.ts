/** @module interface/http/openapi.test — the served document equals the committed `packages/contracts/generated/openapi.json`; named components exist. */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHttpKit } from '../../../test/helpers/http-kit.ts';
import { openApiDocumentJson } from './openapi-json.ts';

const COMMITTED = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'generated',
  'openapi.json',
);

describe('OpenAPI document', () => {
  it('matches the committed document (run `bun scripts/gen-openapi.ts` after contract changes)', () => {
    expect(openApiDocumentJson()).toBe(readFileSync(COMMITTED, 'utf8'));
  });

  it('is served at /api/v1/openapi.json with named components and security schemes', async () => {
    const kit = await createHttpKit({ seed: false });
    const response = await kit.request('GET', '/api/v1/openapi.json');
    const doc = (await response.json()) as {
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['ProblemDetails', 'SessionDetail', 'SessionsPage', 'SystemInfo']),
    );
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      'bearerAuth',
      'cookieAuth',
      'grantAuth',
    ]);
  });
});
