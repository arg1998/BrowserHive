/** @module contracts/test/ids — id grammars and slug parsing */
import { describe, expect, it } from 'bun:test';
import {
  ConnectionId,
  EventId,
  isValidSlug,
  McpSessionId,
  NotificationId,
  OperatorRequestId,
  PrincipalId,
  parseSessionId,
  SessionId,
  SLUG_RE,
  TabId,
} from '../src/ids/index.ts';

describe('ids', () => {
  it('session ids are <slug>-<nanoid8 over 0-9a-z>', () => {
    expect(SessionId.safeParse('shop-a1b2c3d4').success).toBe(true);
    expect(SessionId.safeParse('shop-A1B2C3D4').success).toBe(false);
    expect(SessionId.safeParse('1shop-a1b2c3d4').success).toBe(false);
    expect(SessionId.safeParse('shop-a1b2c3d').success).toBe(false);
    expect(parseSessionId('docs-crawl-0123abcd')).toEqual({
      slug: 'docs-crawl',
      suffix: '0123abcd',
    });
    expect(parseSessionId('nope')).toBeNull();
  });
  it('slug grammar is SLUG_RE', () => {
    expect(SLUG_RE.source).toBe('^[a-z][a-z0-9-]{1,31}$');
    expect(isValidSlug('a1')).toBe(true);
    expect(isValidSlug('a')).toBe(false);
    expect(isValidSlug('-a')).toBe(false);
    expect(isValidSlug('a_b')).toBe(false);
    expect(isValidSlug(`a${'b'.repeat(31)}`)).toBe(true);
    expect(isValidSlug(`a${'b'.repeat(32)}`)).toBe(false);
  });
  it('other ids follow D-23 and spec 02', () => {
    expect(TabId.safeParse('t-abc123').success).toBe(true);
    expect(TabId.safeParse('t-abc12').success).toBe(false);
    expect(EventId.safeParse('e-01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true);
    expect(EventId.safeParse('e-01arz3ndektsv4rrffq69g5fav').success).toBe(false);
    expect(OperatorRequestId.safeParse('a-AbC_-12345xy').success).toBe(true);
    expect(PrincipalId.safeParse('p-AbC_-12345xy').success).toBe(true);
    expect(NotificationId.safeParse('n-AbC_-12345xy').success).toBe(true);
    expect(ConnectionId.safeParse('c-AbC_-12345').success).toBe(true);
    expect(McpSessionId.safeParse('m-AbC_-12345xyAbC_').success).toBe(true);
    expect(McpSessionId.safeParse('m-short').success).toBe(false);
  });
});
