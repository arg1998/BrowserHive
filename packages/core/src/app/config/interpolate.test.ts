/** @module app/config/interpolate.test — the reference pass over a config-file JSON value: string leaves, array elements, object values, never keys (spec 08 §3.1) */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${env:…}` in plain strings is the config-file text under test, not a template.
import { describe, expect, it } from 'bun:test';
import { envLookup, interpolateJson } from './interpolate.ts';

const lookup = envLookup({ HOST: 'collector', TOKEN: 't'.repeat(40), LEVEL: 'debug' }, 'linux');

describe('interpolateJson', () => {
  it('expands a plain string without an `at` position', () => {
    const result = interpolateJson('http://{env:HOST}:4318', lookup);
    expect(result).toEqual({
      value: 'http://collector:4318',
      refs: [{ scheme: 'env', ref: 'HOST', from: 'value' }],
      values: ['collector'],
      problems: [],
    });
  });

  it('expands array elements one by one; a reference never splits an element', () => {
    const result = interpolateJson(['{env:HOST}', '10.0.0.1', '{env:NONE:-a,b}'], lookup);
    expect(result.value).toEqual(['collector', '10.0.0.1', 'a,b']);
    expect(result.refs).toEqual([
      { scheme: 'env', ref: 'HOST', from: 'value', at: '[0]' },
      { scheme: 'env', ref: 'NONE', from: 'default', at: '[2]' },
    ]);
  });

  it('expands object values and never object keys', () => {
    const result = interpolateJson(
      { Authorization: 'Bearer {env:TOKEN}', '{env:HOST}': 'x' },
      lookup,
    );
    expect(result.value).toEqual({ Authorization: `Bearer ${'t'.repeat(40)}`, '{env:HOST}': 'x' });
    expect(result.refs).toEqual([
      { scheme: 'env', ref: 'TOKEN', from: 'value', at: 'Authorization' },
    ]);
    expect(result.values).toEqual(['t'.repeat(40)]);
  });

  it('walks nested objects and arrays with dotted and indexed positions', () => {
    const result = interpolateJson(
      { root: 'info', modules: { sessions: '{env:LEVEL}' }, list: [{ a: '{env:HOST}' }] },
      lookup,
    );
    expect(result.value).toEqual({
      root: 'info',
      modules: { sessions: 'debug' },
      list: [{ a: 'collector' }],
    });
    expect(result.refs.map((ref) => ref.at)).toEqual(['modules.sessions', 'list[0].a']);
  });

  it('passes numbers, booleans and null through untouched', () => {
    for (const value of [4, true, false, null]) {
      expect(interpolateJson(value, lookup)).toEqual({ value, refs: [], values: [], problems: [] });
    }
  });

  it('collects every problem with its position', () => {
    const result = interpolateJson({ a: '{env:NOPE}', b: ['{envv:X}', '${env:HOST}'] }, lookup);
    expect(result.problems.map((p) => [p.problem.kind, p.at])).toEqual([
      ['unset', 'a'],
      ['unknown-scheme', 'b[0]'],
      ['dollar', 'b[1]'],
    ]);
  });

  it('unescapes {{…}} even in a string without references', () => {
    expect(interpolateJson('{{env:HOST}}', lookup)).toMatchObject({
      value: '{env:HOST}',
      refs: [],
    });
  });
});

describe('envLookup', () => {
  const env = { Path: '/bin', lower: 'x' };
  it('is exact outside Windows', () => {
    expect(envLookup(env, 'linux')('PATH')).toBeUndefined();
    expect(envLookup(env, 'darwin')('Path')).toBe('/bin');
  });
  it('is case-insensitive on Windows, as the OS is', () => {
    expect(envLookup(env, 'win32')('PATH')).toBe('/bin');
    expect(envLookup(env, 'win32')('LOWER')).toBe('x');
    expect(envLookup(env, 'win32')('MISSING')).toBeUndefined();
  });
});
