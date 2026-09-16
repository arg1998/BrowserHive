/// <reference types="bun-types" />
/** @module contracts/test/http/endpoints.test — manifest invariants: unique ids and routes, param grammar, scopes, public set */
import { describe, expect, it } from 'bun:test';
import { Scope } from '../../src/enums/index.ts';
import {
  findEndpoint,
  HTTP_ENDPOINTS,
  PASSWORD_CHANGE_ALLOWED_OPERATIONS,
} from '../../src/http/index.ts';

describe('HTTP_ENDPOINTS', () => {
  it('has unique operationIds', () => {
    const ids = HTTP_ENDPOINTS.map((e) => e.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('has unique method+path pairs', () => {
    const keys = HTTP_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('uses camelCase operationIds and lowercase methods', () => {
    for (const e of HTTP_ENDPOINTS) {
      expect(e.operationId).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(e.method).toMatch(/^(get|head|post|put|patch|delete)$/);
    }
  });
  it('uses OpenAPI-style snake_case path params and no trailing slash', () => {
    for (const e of HTTP_ENDPOINTS) {
      expect(e.path.startsWith('/')).toBe(true);
      expect(e.path.endsWith('/')).toBe(false);
      for (const seg of e.path.split('/').slice(1)) {
        expect(seg).toMatch(/^(\{[a-z][a-z0-9_]*\}|[a-z0-9.-]+)$/);
      }
    }
  });
  it('declares only registry scopes', () => {
    for (const e of HTTP_ENDPOINTS) {
      if (e.scope !== null) expect(Scope.safeParse(e.scope).success).toBe(true);
    }
  });
  it('keeps the public surface to health, login, openapi and docs', () => {
    const publicOps = HTTP_ENDPOINTS.filter((e) => e.auth.length === 0).map((e) => e.operationId);
    expect(publicOps.sort()).toEqual(['getDocs', 'getHealth', 'getOpenApi', 'login'].sort());
  });
  it('grant-enabled routes are exactly trace.zip and screenshot bytes', () => {
    const grant = HTTP_ENDPOINTS.filter((e) => e.auth.includes('grant')).map((e) => e.operationId);
    expect(grant.sort()).toEqual(['getScreenshotImage', 'getTraceZip', 'headTraceZip'].sort());
  });
  it('mutating routes require a scope unless they are auth/preferences/client-error routes', () => {
    for (const e of HTTP_ENDPOINTS) {
      if (e.method === 'get' || e.method === 'head') continue;
      if (e.path.startsWith('/auth/') || e.path === '/client-errors') continue;
      expect(e.scope).not.toBeNull();
    }
  });
  it('password-change gate names existing operations', () => {
    for (const op of PASSWORD_CHANGE_ALLOWED_OPERATIONS) expect(findEndpoint(op)).toBeDefined();
    expect(findEndpoint('nope')).toBeUndefined();
  });
});
