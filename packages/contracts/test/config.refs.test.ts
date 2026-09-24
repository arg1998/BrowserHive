/** @module contracts/test/config.refs — table tests for the `{env:NAME}` scanner and expansion (spec 08 §3.1, D-29) */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${env:…}` in plain strings is the config-file text under test, not a template.
import { describe, expect, it } from 'bun:test';
import {
  expandRefs,
  firstRefLike,
  formatRefNames,
  formatShadowLine,
  type KeyProvenance,
  refTokenText,
  scanRefs,
  sourceWithRefs,
  type ValueRef,
} from '../src/config/index.ts';

const ENV: Readonly<Record<string, string>> = {
  HOST: 'collector.internal',
  PORT: '4318',
  EMPTY: '',
  TOKEN: 't'.repeat(40),
  NESTED: '{env:HOST}',
  lower_case: 'x',
};
const lookup = (name: string): string | undefined => ENV[name];

interface ExpandRow {
  readonly input: string;
  /** Expected value; omitted when problems are expected. */
  readonly value?: string;
  readonly refs?: readonly Pick<ValueRef, 'ref' | 'from'>[];
  /** Expected problem kinds, in order. */
  readonly problems?: readonly string[];
}

const ROWS: readonly ExpandRow[] = [
  { input: 'plain text', value: 'plain text', refs: [] },
  { input: '{env:HOST}', value: 'collector.internal', refs: [{ ref: 'HOST', from: 'value' }] },
  {
    input: 'http://{env:HOST}:{env:PORT}/v1',
    value: 'http://collector.internal:4318/v1',
    refs: [
      { ref: 'HOST', from: 'value' },
      { ref: 'PORT', from: 'value' },
    ],
  },
  { input: '{env:HOST}{env:HOST}', value: 'collector.internalcollector.internal' },
  {
    input: '{env:MISSING:-127.0.0.1}',
    value: '127.0.0.1',
    refs: [{ ref: 'MISSING', from: 'default' }],
  },
  { input: '{env:EMPTY:-fallback}', value: 'fallback', refs: [{ ref: 'EMPTY', from: 'default' }] },
  {
    input: '{env:HOST:-fallback}',
    value: 'collector.internal',
    refs: [{ ref: 'HOST', from: 'value' }],
  },
  { input: '{env:MISSING:-}', value: '', refs: [{ ref: 'MISSING', from: 'default' }] },
  { input: '{env:MISSING:-a:b-c:-d}', value: 'a:b-c:-d' },
  { input: '{env:MISSING:-{env:HOST}}', problems: ['malformed'] },
  { input: '{env:lower_case}', value: 'x' },
  { input: '{env:_X:-y}', value: 'y' },
  // the escape
  { input: '{{env:HOST}}', value: '{env:HOST}', refs: [] },
  { input: 'a {{file:/x}} b', value: 'a {file:/x} b' },
  { input: '${{env:HOST}}', value: '${env:HOST}' },
  { input: '{{env:HOST}', value: '{collector.internal' },
  // literal braces
  {
    input: 'https://grafana.local/explore?traceId={trace_id}',
    value: 'https://grafana.local/explore?traceId={trace_id}',
  },
  { input: '{trace:id="{trace_id}"}', value: '{trace:id="{trace_id}"}' },
  { input: '{}', value: '{}' },
  { input: '{a:b', value: '{a:b' },
  { input: 'a}b', value: 'a}b' },
  { input: '{0:C}', value: '{0:C}' },
  { input: '{ env:HOST }', value: '{ env:HOST }' },
  { input: '{{trace_id}}', value: '{{trace_id}}' },
  { input: '{"datasource":"tempo"}', value: '{"datasource":"tempo"}' },
  // another tool's ${…} syntax stays literal; only ${env:…} is flagged
  { input: '${var:format}', value: '${var:format}' },
  { input: '${VAR:-x}', value: '${VAR:-x}' },
  { input: 'Bearer ${input:token}', value: 'Bearer ${input:token}' },
  { input: '${env:HOST}', problems: ['dollar'] },
  { input: '${ENV:HOST}', problems: ['dollar'] },
  // required references
  { input: '{env:MISSING}', problems: ['unset'] },
  { input: '{env:EMPTY}', problems: ['empty'] },
  { input: '{env:MISSING} and {env:EMPTY} and {env:ALSO}', problems: ['unset', 'empty', 'unset'] },
  // malformed: `{env:` always starts a reference
  { input: '{env:}', problems: ['malformed'] },
  { input: '{env:1X}', problems: ['malformed'] },
  { input: '{env:A-B}', problems: ['malformed'] },
  { input: '{env:A:B}', problems: ['malformed'] },
  { input: '{env:HOST', problems: ['malformed'] },
  { input: '{env:X:-café}', problems: ['malformed'] },
  { input: '{env:} {env:MISSING}', problems: ['malformed'] },
  { input: '{env:MISSING} {env:}', problems: ['unset', 'malformed'] },
  // unknown schemes, including mis-cased env
  { input: '{envv:HOST}', problems: ['unknown-scheme'] },
  { input: '{ENV:HOST}', problems: ['unknown-scheme'] },
  { input: '{Env:HOST}', problems: ['unknown-scheme'] },
  { input: '{file:/run/secrets/token}', problems: ['unknown-scheme'] },
  { input: '{cmd:cat /etc/passwd}', problems: ['unknown-scheme'] },
  { input: '{v:>10.2f}', problems: ['unknown-scheme'] },
  { input: '{span:name="GET"}', problems: ['unknown-scheme'] },
  // expanded text is never rescanned
  { input: '{env:NESTED}', value: '{env:HOST}', refs: [{ ref: 'NESTED', from: 'value' }] },
];

describe('expandRefs (spec 08 §3.1)', () => {
  for (const row of ROWS) {
    it(`${JSON.stringify(row.input)} → ${row.problems === undefined ? JSON.stringify(row.value) : row.problems.join(', ')}`, () => {
      const result = expandRefs(row.input, lookup);
      expect(result.problems.map((p): string => p.kind)).toEqual([...(row.problems ?? [])]);
      if (row.problems !== undefined) return;
      expect(result.value).toBe(row.value ?? '');
      if (row.refs !== undefined) {
        expect(result.refs.map(({ ref, from }) => ({ ref, from }))).toEqual([...row.refs]);
      }
      expect(result.values).toHaveLength(result.refs.length);
      expect(result.refs.every((r) => r.scheme === 'env' && r.at === undefined)).toBe(true);
    });
  }

  it('returns the values the references produced, parallel to refs', () => {
    const result = expandRefs('Bearer {env:TOKEN} {env:MISSING:-x}', lookup);
    expect(result.values).toEqual(['t'.repeat(40), 'x']);
  });

  it('reads each variable through the injected lookup only', () => {
    const asked: string[] = [];
    expandRefs('{env:A:-1}{env:B:-2}{{env:C}}', (name) => {
      asked.push(name);
      return undefined;
    });
    expect(asked).toEqual(['A', 'B']);
  });
});

describe('scanRefs', () => {
  it('keeps the text as written in every token and merges adjacent literals', () => {
    expect(scanRefs('a{b}c{env:X:-d}e')).toEqual([
      { kind: 'literal', text: 'a{b}c' },
      { kind: 'ref', text: '{env:X:-d}', scheme: 'env', name: 'X', fallback: 'd' },
      { kind: 'literal', text: 'e' },
    ]);
  });

  it('stops at a malformed reference and keeps the rest as one literal', () => {
    expect(scanRefs('x{env:A:-{env:B}}y')).toEqual([
      { kind: 'literal', text: 'x' },
      { kind: 'malformed', text: '{env:A:-{env:B}' },
      { kind: 'literal', text: '}y' },
    ]);
  });

  it('names the scheme of an unknown reference', () => {
    expect(scanRefs('{file:/run/x}')).toEqual([
      { kind: 'unknown-scheme', text: '{file:/run/x}', scheme: 'file' },
    ]);
  });
});

describe('refTokenText (message rendering)', () => {
  const token = (text: string) => {
    const found = scanRefs(text)[0];
    if (found === undefined) throw new Error('no token');
    return found;
  };
  it('shows the text as written for keys that are not secret', () => {
    expect(refTokenText(token('{env:A:-http://x}'), false)).toBe('{env:A:-http://x}');
    expect(refTokenText(token('{file:/run/x}'), false)).toBe('{file:/run/x}');
  });
  it('shows only names on secret keys, never a default or a body', () => {
    expect(refTokenText(token('{env:A}'), true)).toBe('{env:A}');
    expect(refTokenText(token('{env:A:-literal}'), true)).toBe('{env:A:-…}');
    expect(refTokenText(token('${env:A}'), true)).toBe('${env:A}');
    expect(refTokenText(token('${env:A:-x}'), true)).toBe('${env:A:-…}');
    expect(refTokenText(token('${env:bad name}'), true)).toBe('${env:…}');
    expect(refTokenText(token('{file:/run/x}'), true)).toBe('{file:…}');
    expect(refTokenText(token('{env:}'), true)).toBe('{env:…}');
  });
});

describe('firstRefLike (warning for values that are not expanded)', () => {
  it('finds references, ${env:…} and malformed {env:…}, but not other braces', () => {
    expect(firstRefLike('http://{env:HOST}:4318')?.text).toBe('{env:HOST}');
    expect(firstRefLike('${env:HOST}')?.text).toBe('${env:HOST}');
    expect(firstRefLike('{env:}')?.text).toBe('{env:}');
    expect(firstRefLike('{trace_id}')).toBeUndefined();
    expect(firstRefLike('{file:/x}')).toBeUndefined();
    expect(firstRefLike('{{env:X}}')).toBeUndefined();
    expect(firstRefLike('plain')).toBeUndefined();
  });
});

describe('provenance rendering with references', () => {
  const refs: readonly ValueRef[] = [
    { scheme: 'env', ref: 'A', from: 'value' },
    { scheme: 'env', ref: 'B', from: 'default' },
    { scheme: 'env', ref: 'A', from: 'value' },
  ];
  it('lists names once, in order, marking defaults', () => {
    expect(formatRefNames(refs)).toBe('$A, $B (default)');
    expect(formatRefNames(undefined)).toBe('');
    expect(formatRefNames([])).toBe('');
    expect(sourceWithRefs('file', refs)).toBe('config-file via $A, $B (default)');
    expect(sourceWithRefs('env')).toBe('env');
  });
  it('formats shadow lines with the variables on either side', () => {
    const provenance: KeyProvenance = {
      key: 'otelEndpoint',
      source: 'cli',
      rendered: 'http://cli:4318',
      shadowed: [
        {
          source: 'file',
          raw: 'http://collector.internal:4318',
          location: 'f',
          refs: [refs[0] as ValueRef],
        },
        { source: 'env', raw: 'http://127.0.0.1:4318', location: 'BROWSERHIVE_OTEL_ENDPOINT' },
      ],
    };
    expect(formatShadowLine(provenance, (v) => v.raw)).toBe(
      'config: otelEndpoint=http://cli:4318 (cli) shadows config-file=http://collector.internal:4318 via $A, env=http://127.0.0.1:4318',
    );
    expect(
      formatShadowLine(
        {
          ...provenance,
          source: 'file',
          refs: [refs[1] as ValueRef],
          shadowed: [provenance.shadowed[1] as never],
        },
        (v) => v.raw,
      ),
    ).toBe(
      'config: otelEndpoint=http://cli:4318 (config-file via $B (default)) shadows env=http://127.0.0.1:4318',
    );
  });
});
