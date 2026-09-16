/** @module app/config/argv.test — unit tests for argv */
import { describe, expect, it } from 'bun:test';
import { negatedName, tokenizeArgs } from './argv.ts';

const BOOLEANS = new Set(['admin', 'otel', 'allowInsecureBind']);
const KNOWN = new Set([
  ...BOOLEANS,
  'port',
  'maxSessions',
  'trustedProxies',
  'otelHeaders',
  'config',
]);
const options = { isBoolean: (n: string) => BOOLEANS.has(n), known: (n: string) => KNOWN.has(n) };

function flags(argv: readonly string[]) {
  return Object.fromEntries(tokenizeArgs(argv, options).flags);
}

describe('tokenizeArgs', () => {
  it('accepts --key value and --key=value', () => {
    expect(flags(['--port', '1234'])).toEqual({ port: ['1234'] });
    expect(flags(['--port=1234'])).toEqual({ port: ['1234'] });
    expect(flags(['--maxSessions=unbounded'])).toEqual({ maxSessions: ['unbounded'] });
  });

  it('keeps every occurrence in order so rightmost wins and lists concatenate', () => {
    expect(flags(['--port', '1', '--port', '2'])).toEqual({ port: ['1', '2'] });
    expect(flags(['--trustedProxies', 'a', '--trustedProxies=b,c'])).toEqual({
      trustedProxies: ['a', 'b,c'],
    });
    expect(flags(['--otelHeaders', 'k=v', '--otelHeaders', 'k2=v2'])).toEqual({
      otelHeaders: ['k=v', 'k2=v2'],
    });
  });

  it('treats a bare boolean flag as true and never swallows the next token', () => {
    const tokens = tokenizeArgs(['--admin', 'serve'], options);
    expect(Object.fromEntries(tokens.flags)).toEqual({ admin: ['true'] });
    expect(tokens.positionals).toEqual(['serve']);
    expect(flags(['--admin', 'false'])).toEqual({ admin: ['true'] });
  });

  it('accepts --bool=false and the --noBool negation', () => {
    expect(flags(['--admin=false'])).toEqual({ admin: ['false'] });
    expect(flags(['--noAdmin'])).toEqual({ admin: ['false'] });
    expect(flags(['--noAllowInsecureBind'])).toEqual({ allowInsecureBind: ['false'] });
    expect(flags(['--admin', '--noAdmin'])).toEqual({ admin: ['true', 'false'] });
    expect(flags(['--otel=0'])).toEqual({ otel: ['0'] });
  });

  it('does not negate non-boolean or unknown flags', () => {
    const tokens = tokenizeArgs(['--noPort', '--noThing'], options);
    expect(tokens.unknown).toEqual(['--noPort', '--noThing']);
    expect(tokens.flags.size).toBe(0);
  });

  it('ends flag parsing at --', () => {
    const tokens = tokenizeArgs(['--port', '1', '--', '--admin', 'x'], options);
    expect(Object.fromEntries(tokens.flags)).toEqual({ port: ['1'] });
    expect(tokens.positionals).toEqual(['--admin', 'x']);
  });

  it('collects unknown flags once, swallowing a probable value, and never consumes flags as values', () => {
    const tokens = tokenizeArgs(
      ['--max-sessions', '2', '--maxsessions', '--max-sessions=3', '--port'],
      options,
    );
    expect(tokens.unknown).toEqual(['--max-sessions', '--maxsessions']);
    expect(tokens.positionals).toEqual([]);
    expect(tokens.missingValue).toEqual(['--port']);
    expect(tokenizeArgs(['--port', '--admin'], options).missingValue).toEqual(['--port']);
  });

  it('reports value-taking flags at the end of argv as missing a value', () => {
    expect(tokenizeArgs(['--config'], options).missingValue).toEqual(['--config']);
    expect(flags(['--port='])).toEqual({ port: [''] });
  });

  it('collects short flags per letter and keeps other tokens positional', () => {
    const tokens = tokenizeArgs(['-h', '-vx', 'file.db', '-', '--'], options);
    expect(tokens.shortFlags).toEqual(['-h', '-v', '-x']);
    expect(tokens.positionals).toEqual(['file.db', '-']);
  });

  it('defaults to every flag known and value-taking', () => {
    const tokens = tokenizeArgs(['--out', 'x.db', '--dryRun']);
    expect(Object.fromEntries(tokens.flags)).toEqual({ out: ['x.db'] });
    expect(tokens.missingValue).toEqual(['--dryRun']);
  });
});

describe('negatedName', () => {
  it('maps --noAdmin to admin and rejects other shapes', () => {
    expect(negatedName('noAdmin')).toBe('admin');
    expect(negatedName('noAllowInsecureBind')).toBe('allowInsecureBind');
    expect(negatedName('no')).toBeUndefined();
    expect(negatedName('noadmin')).toBeUndefined();
    expect(negatedName('notify')).toBeUndefined();
  });
});
