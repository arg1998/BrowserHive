/** @module app/config/json-parse.test — unit tests for json-parse */
import { describe, expect, it } from 'bun:test';
import { isJsonObject, parseJson } from './json-parse.ts';

describe('parseJson', () => {
  it('parses every JSON value type like JSON.parse', () => {
    const text = '{"a":[1,-2.5e3,true,false,null,"s\\n\\u0041"],"b":{"c":{}},"d":[]}';
    const parsed = parseJson(text);
    expect(parsed).toEqual({ ok: true, value: JSON.parse(text) });
    expect(parseJson('  42 ')).toEqual({ ok: true, value: 42 });
    expect(parseJson('"x"')).toEqual({ ok: true, value: 'x' });
  });

  it('reports line and column of the failure', () => {
    expect(parseJson('{\n  "a": 1,\n  "b": }')).toEqual({
      ok: false,
      error: { line: 3, column: 8, message: "unexpected token '}'" },
    });
    expect(parseJson('{"a": 1')).toEqual({
      ok: false,
      error: { line: 1, column: 8, message: "expected ',' or '}', got end of input" },
    });
    expect(parseJson('')).toEqual({
      ok: false,
      error: { line: 1, column: 1, message: 'unexpected end of input' },
    });
  });

  it('rejects comments, trailing commas and single quotes with specific messages', () => {
    expect(parseJson('{\n// c\n"a":1}')).toEqual({
      ok: false,
      error: { line: 2, column: 1, message: "expected a quoted key, got token '/'" },
    });
    expect(parseJson('{"a":1,}')).toEqual({
      ok: false,
      error: { line: 1, column: 8, message: 'trailing commas are not allowed' },
    });
    expect(parseJson('[1,]')).toEqual({
      ok: false,
      error: { line: 1, column: 4, message: 'trailing commas are not allowed' },
    });
    expect(parseJson("{'a':1}").ok).toBe(false);
    expect(parseJson('// x').ok).toBe(false);
    expect(parseJson("'x'")).toEqual({
      ok: false,
      error: { line: 1, column: 1, message: 'strings must use double quotes' },
    });
  });

  it('rejects trailing garbage, control characters in strings and malformed numbers', () => {
    expect(parseJson('{} {}').ok).toBe(false);
    expect(parseJson('"a\tb"').ok).toBe(false);
    expect(parseJson('01').ok).toBe(false);
    expect(parseJson('-').ok).toBe(false);
    expect(parseJson('tru').ok).toBe(false);
  });
});

describe('isJsonObject', () => {
  it('accepts plain objects only', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('x')).toBe(false);
  });
});
