/** @module infra/browsers/cors-request.test — which routed requests Chromium preflights (D-66 fail-closed mode). */

import { describe, expect, it } from 'bun:test';
import { type CorsRequestFacts, needsPreflight } from './cors-request.ts';

const PAGE = 'https://site.test';
const BROWSER = {
  origin: PAGE,
  referer: `${PAGE}/`,
  'user-agent': 'Mozilla/5.0',
  'sec-ch-ua': '"Chromium";v="153"',
  'sec-ch-ua-mobile': '?0',
  accept: '*/*',
};

function request(over: Partial<CorsRequestFacts> & { extra?: Record<string, string> }) {
  return {
    url: over.url ?? 'https://api.test/w',
    method: over.method ?? 'POST',
    resourceType: over.resourceType ?? 'fetch',
    headers: over.headers ?? { ...BROWSER, ...over.extra },
  };
}

describe('needsPreflight', () => {
  it('a cross-origin request with a non-simple method, header or content type', () => {
    expect(needsPreflight(request({ method: 'PUT' }))).toBe(true);
    expect(needsPreflight(request({ method: 'delete' }))).toBe(true);
    expect(needsPreflight(request({ extra: { 'content-type': 'application/json' } }))).toBe(true);
    expect(needsPreflight(request({ extra: { 'x-custom': '1' } }))).toBe(true);
    expect(needsPreflight(request({ extra: { authorization: 'Bearer x' } }))).toBe(true);
    expect(needsPreflight(request({ headers: { origin: 'null', 'x-custom': '1' } }))).toBe(true);
  });

  it('not a simple request, a same-origin one, a navigation or one without Origin', () => {
    for (const type of [
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      expect(needsPreflight(request({ extra: { 'content-type': type } }))).toBe(false);
    }
    expect(needsPreflight(request({ method: 'GET' }))).toBe(false);
    expect(
      needsPreflight(request({ extra: { 'accept-language': 'en', range: 'bytes=0-1' } })),
    ).toBe(false);
    expect(needsPreflight(request({ url: `${PAGE}/api`, method: 'PUT' }))).toBe(false);
    expect(needsPreflight(request({ resourceType: 'document', method: 'PUT' }))).toBe(false);
    expect(needsPreflight(request({ headers: { 'x-custom': '1' } }))).toBe(false);
    expect(needsPreflight(request({ url: 'not a url', method: 'PUT' }))).toBe(false);
    // Headers Chromium adds itself never count.
    expect(
      needsPreflight(
        request({
          extra: {
            'cache-control': 'no-cache',
            pragma: 'no-cache',
            'sec-fetch-mode': 'cors',
            'upgrade-insecure-requests': '1',
            'proxy-authorization': 'x',
          },
        }),
      ),
    ).toBe(false);
  });
});
