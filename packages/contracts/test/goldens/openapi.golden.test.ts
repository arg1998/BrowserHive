/** @module contracts/test/goldens/openapi — invariants of the committed OpenAPI 3.1 document (spec 09 §3.1); regenerate with `bun scripts/gen-openapi.ts`, drift is caught by `--check` and the core freshness test. */
/// <reference types="bun-types" />

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { API_PREFIX, HTTP_ENDPOINTS } from '../../src/http/index.ts';

const DOCUMENT_PATH = `${import.meta.dir}/../../generated/openapi.json`;

const Media = z.record(z.string(), z.object({ schema: z.unknown() }));
const Operation = z.object({
  operationId: z.string(),
  responses: z.record(z.string(), z.object({ description: z.string(), content: Media.optional() })),
});
const Document = z.object({
  openapi: z.literal('3.1.0'),
  paths: z.record(z.string(), z.record(z.string(), Operation)),
  components: z.object({
    schemas: z.record(
      z.string(),
      z.object({ properties: z.record(z.string(), z.unknown()).optional() }),
    ),
  }),
});

const document = Document.parse(JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8')));
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({ path, method, op })),
);

describe('openapi.json golden', () => {
  it('has exactly the manifest operations at the manifest paths', () => {
    const actual = operations.map((o) => `${o.method} ${o.path} ${o.op.operationId}`).sort();
    const expected = HTTP_ENDPOINTS.map(
      (e) => `${e.method} ${API_PREFIX}${e.path} ${e.operationId}`,
    ).sort();
    expect(actual).toEqual(expected);
  });

  it('every operation documents at least one problem+json response', () => {
    for (const { op } of operations) {
      const problems = Object.values(op.responses).filter(
        (r) => r.content?.['application/problem+json'] !== undefined,
      );
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  it('every collection response uses the shared Page envelope', () => {
    const refs = new Set<string>();
    for (const { op } of operations) {
      const ok = op.responses['200']?.content?.['application/json']?.schema;
      const parsed = z.object({ $ref: z.string() }).safeParse(ok);
      if (parsed.success && parsed.data.$ref.endsWith('Page'))
        refs.add(parsed.data.$ref.split('/').pop() ?? '');
    }
    expect(refs.size).toBeGreaterThan(10);
    for (const name of refs) {
      const properties = Object.keys(document.components.schemas[name]?.properties ?? {});
      expect(properties).toEqual(expect.arrayContaining(['data', 'page', 'applied', 'meta']));
    }
  });
});
