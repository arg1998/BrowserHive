/// <reference types="bun-types" />
/** @module contracts/test/http/common.test — list query parsing: csv filters, limit bounds, sort allow-lists, strictness */
import { describe, expect, it } from 'bun:test';
import {
  csv,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  listQuery,
  PageQuery,
  QueryBool,
  sortable,
} from '../../src/http/common.ts';
import { LogsQuery, SessionsQuery, ToolCallsQuery } from '../../src/http/index.ts';

describe('PageQuery', () => {
  it('applies defaults', () => {
    expect(PageQuery.parse({})).toEqual({ limit: LIMIT_DEFAULT, dir: 'desc', total: false });
  });
  it('bounds limit', () => {
    expect(PageQuery.parse({ limit: String(LIMIT_MAX) }).limit).toBe(LIMIT_MAX);
    expect(PageQuery.safeParse({ limit: String(LIMIT_MAX + 1) }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: '0' }).success).toBe(false);
  });
  it('rejects unknown keys instead of dropping them', () => {
    const r = PageQuery.safeParse({ bogus: '1' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues[0];
      expect(issue?.code).toBe('unrecognized_keys');
      expect(issue?.code === 'unrecognized_keys' ? issue.keys : []).toEqual(['bogus']);
    }
  });
  it('rejects cursors that are not base64url', () => {
    expect(PageQuery.safeParse({ cursor: 'a+b/c=' }).success).toBe(false);
    expect(PageQuery.safeParse({ cursor: 'eyJ0cyI6MX0' }).success).toBe(true);
  });
});

describe('csv()', () => {
  const schema = csv(sortable(['a', 'b']));
  it('accepts repeated params and comma lists', () => {
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(schema.parse('a,b')).toEqual(['a', 'b']);
    expect(schema.parse(['a,b', 'a'])).toEqual(['a', 'b', 'a']);
  });
  it('rejects unknown values and yields undefined for empty input', () => {
    expect(schema.safeParse('c').success).toBe(false);
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse('')).toBeUndefined();
  });
});

describe('QueryBool', () => {
  it('parses the four string forms', () => {
    expect(QueryBool.parse('true')).toBe(true);
    expect(QueryBool.parse('1')).toBe(true);
    expect(QueryBool.parse('false')).toBe(false);
    expect(QueryBool.parse('0')).toBe(false);
    expect(QueryBool.safeParse('yes').success).toBe(false);
  });
});

describe('listQuery()', () => {
  it('rejects a sort key outside the allow-list, naming the field', () => {
    const r = SessionsQuery.safeParse({ sort: 'nope' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['sort']);
  });
  it('applies the default sort and resource defaults', () => {
    const q = SessionsQuery.parse({});
    expect(q.sort).toBe('created_at');
    expect(q.view).toBe('all');
    expect(q.archived).toBe('exclude');
  });
  it('parses multi-value filters and coerces booleans/timestamps', () => {
    const q = ToolCallsQuery.parse({ tool: 'navigate,click', ok: 'false', since: '1735689600000' });
    expect(q.tool).toEqual(['navigate', 'click']);
    expect(q.ok).toBe(false);
    expect(q.since).toBe(1_735_689_600_000);
  });
  it('honours per-resource limit bounds', () => {
    expect(LogsQuery.parse({}).limit).toBe(200);
    expect(LogsQuery.parse({ limit: '1000' }).limit).toBe(1000);
    expect(LogsQuery.safeParse({ limit: '1001' }).success).toBe(false);
  });
  it('keeps strictness through extend', () => {
    const q = listQuery({ sort: sortable(['x']).default('x'), filters: {} });
    expect(q.safeParse({ unknown: 1 }).success).toBe(false);
  });
});
