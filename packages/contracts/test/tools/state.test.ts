/** @module contracts/test/tools/state.test — cookie shapes and viewport constraints */
/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import {
  GET_COOKIES,
  SET_COOKIES,
  SET_EXTRA_HTTP_HEADERS,
  SET_VIEWPORT,
} from '../../src/tools/state.ts';

describe('set_cookies input', () => {
  it('requires name+value and passes the rest of the Playwright cookie surface through', () => {
    const parsed = SET_COOKIES.input.parse({
      session_id: 's',
      cookies: [{ name: 'a', value: '1', url: 'https://x.test', sameSite: 'Lax', expires: 1 }],
    });
    expect(parsed.cookies[0]).toEqual({
      name: 'a',
      value: '1',
      url: 'https://x.test',
      sameSite: 'Lax',
      expires: 1,
    });
  });

  it('needs at least one entry with the stable message', () => {
    const result = SET_COOKIES.input.safeParse({ session_id: 's', cookies: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('cookies must include at least one entry');
    }
    expect(SET_COOKIES.input.safeParse({ session_id: 's', cookies: [{ name: 'a' }] }).success).toBe(
      false,
    );
  });
});

describe('get_cookies output', () => {
  it('accepts Playwright cookies (with optional partitionKey) and has no session_id key', () => {
    const cookie = {
      name: 'a',
      value: '1',
      domain: 'x.test',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'None',
    } as const;
    expect(GET_COOKIES.output.parse({ cookies: [cookie] })).toEqual({ cookies: [cookie] });
    expect(
      GET_COOKIES.output.safeParse({ cookies: [{ ...cookie, partitionKey: 'https://x.test' }] })
        .success,
    ).toBe(true);
    expect(
      GET_COOKIES.output.safeParse({ cookies: [{ ...cookie, sameSite: 'lax' }] }).success,
    ).toBe(false);
    expect(GET_COOKIES.input.parse({ session_id: 's', urls: ['https://x.test'] })).toEqual({
      session_id: 's',
      urls: ['https://x.test'],
    });
  });
});

describe('set_viewport', () => {
  it('requires positive integers and only reports clamped when true', () => {
    expect(SET_VIEWPORT.input.safeParse({ session_id: 's', width: 0, height: 10 }).success).toBe(
      false,
    );
    expect(SET_VIEWPORT.input.safeParse({ session_id: 's', width: 1.5, height: 10 }).success).toBe(
      false,
    );
    expect(SET_VIEWPORT.output.parse({ session_id: 's', width: 1, height: 1 })).toEqual({
      session_id: 's',
      width: 1,
      height: 1,
    });
    expect(
      SET_VIEWPORT.output.safeParse({ session_id: 's', width: 1, height: 1, clamped: false })
        .success,
    ).toBe(false);
  });
});

describe('set_extra_http_headers', () => {
  it('takes a string record and reports applied/rejected', () => {
    expect(
      SET_EXTRA_HTTP_HEADERS.input.safeParse({ session_id: 's', headers: { a: 1 } }).success,
    ).toBe(false);
    expect(
      SET_EXTRA_HTTP_HEADERS.output.parse({
        session_id: 's',
        applied: 1,
        rejected: ['user-agent'],
      }),
    ).toEqual({ session_id: 's', applied: 1, rejected: ['user-agent'] });
  });
});
