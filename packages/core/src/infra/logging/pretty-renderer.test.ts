/** @module infra/logging/pretty-renderer.test — column-aligned layout snapshots with colours off, colour markers on. */

import { describe, expect, it } from 'bun:test';
import { ANSI, stripAnsi } from './color.ts';
import { FIELD_COLUMN, MAX_MESSAGE_LENGTH, renderPretty, VAULT_TAG } from './pretty-renderer.ts';
import type { LogRecord } from './record.ts';

// The test preload pins TZ=UTC, so 1970-01-01T14:23:07.412Z renders as 14:23:07.412.
const TS = 14 * 3_600_000 + 23 * 60_000 + 7_412;

function record(
  extra: Record<string, unknown>,
  level: LogRecord['level'] = 'info',
  msg = 'tool call',
): LogRecord {
  return { ts: TS, level, msg, module: 'mcp', ...extra };
}

describe('renderPretty (colours off)', () => {
  it('lays out time, level, padded message and priority-ordered fields', () => {
    const line = renderPretty(
      record({ duration_ms: 412, session_id: 'shop-a1b2', tool: 'navigate', module: 'mcp' }),
      { color: false },
    );
    expect(line).toBe(
      '14:23:07.412 INFO  tool call                  tool=navigate session_id=shop-a1b2 duration_ms=412 module=mcp',
    );
    expect(line.indexOf('tool=')).toBe(FIELD_COLUMN);
    expect(MAX_MESSAGE_LENGTH).toBe(26);
  });

  it('matches the snapshot for a wrapped warn line', () => {
    const line = renderPretty(
      record(
        {
          tool: 'vault_fill',
          session_id: 'shop-a1b2',
          error_code: 'VAULT_FILL_AUTH_FAILED',
          reported: true,
          entry_name: 'github',
          result: 'auth_failed',
        },
        'warn',
        'tool call failed',
      ),
      { color: false, width: 100 },
    );
    expect(line).toMatchSnapshot();
    const rows = line.split('\n');
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(1)) expect(row).toMatch(new RegExp(`^ {${FIELD_COLUMN}}\\S`));
  });

  it('omits null/undefined, quotes whitespace strings, JSON-encodes objects', () => {
    const line = renderPretty(
      record({ a: null, b: undefined, note: 'two words', obj: { k: 1 }, n: 3, ok: false }),
      { color: false },
    );
    expect(line).toBe(
      '14:23:07.412 INFO  tool call                  module=mcp n=3 note="two words" obj={"k":1} ok=false',
    );
  });

  it('keeps an unbreakable token intact on its own line', () => {
    const url = `https://example.com/${'x'.repeat(120)}`;
    const line = renderPretty(record({ url, tool: 'navigate' }), { color: false, width: 80 });
    const rows = line.split('\n');
    expect(rows[0]).toBe('14:23:07.412 INFO  tool call                  tool=navigate');
    expect(rows[1]?.trim()).toBe(`url=${url}`);
  });

  it('wraps prose at spaces and puts detail/stack/err.stack last', () => {
    const detail = 'the quick brown fox jumps over the lazy dog '.repeat(4).trim();
    const line = renderPretty(
      record(
        {
          zeta: 1,
          detail,
          err: {
            name: 'Error',
            message: 'boom',
            stack: 'Error: boom\n    at x.ts:1:1',
            cause: { name: 'TypeError', message: 'inner' },
          },
          tool: 'evaluate',
        },
        'error',
        'tool call failed',
      ),
      { color: false, width: 100 },
    );
    expect(line).toMatchSnapshot();
    const keys = line
      .split(/\s+/)
      .filter((t) => t.includes('='))
      .map((t) => t.slice(0, t.indexOf('=')));
    expect(keys[0]).toBe('tool');
    expect(keys.indexOf('detail')).toBeGreaterThan(keys.indexOf('zeta'));
    expect(keys[keys.length - 1]).toBe('err.stack');
    expect(line).toContain('err.cause="TypeError: inner"');
  });

  it('hides trace/span ids and the vault flag; tags vault lines when colours are off', () => {
    const line = renderPretty(
      record(
        { vault: true, trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), entry_name: 'gh' },
        'info',
        'vault fill',
      ),
      { color: false },
    );
    expect(line).toBe(
      `14:23:07.412 INFO  vault fill ${VAULT_TAG}         entry_name=gh module=mcp`,
    );
    expect(line).not.toContain('trace_id');
  });

  it('a long message pushes fields right instead of truncating', () => {
    const msg = 'a message that is much longer than twenty six chars';
    const line = renderPretty(record({ a: 1 }, 'info', msg), { color: false });
    expect(line).toContain(`${msg} a=1`);
  });

  it('renders a line without fields without trailing whitespace', () => {
    expect(
      renderPretty({ ts: TS, level: 'debug', msg: 'tick', module: 'x' }, { color: false }),
    ).toBe('14:23:07.412 DEBUG tick                       module=x');
  });
});

describe('renderPretty (colours on)', () => {
  it('paints level, codes, urls, ids, numbers and the vault message', () => {
    const line = renderPretty(
      record(
        {
          vault: true,
          error_code: 'X',
          url: 'https://e.com/',
          session_id: 's-1',
          n: 2,
          result: 'success',
        },
        'warn',
        'vault fill',
      ),
      { color: true, width: 160 },
    );
    expect(line).toContain(`${ANSI.bold}${ANSI.yellow}WARN ${ANSI.reset}`);
    expect(line).toContain(`${ANSI.magenta}vault fill${ANSI.reset}`);
    expect(line).toContain(`${ANSI.red}X${ANSI.reset}`);
    expect(line).toContain(`${ANSI.yellow}https://e.com/${ANSI.reset}`);
    expect(line).toContain(`${ANSI.blue}s-1${ANSI.reset}`);
    expect(line).toContain(`${ANSI.cyan}2${ANSI.reset}`);
    expect(line).toContain(`${ANSI.green}success${ANSI.reset}`);
    expect(line).not.toContain(VAULT_TAG);
    expect(stripAnsi(line)).toBe(
      '14:23:07.412 WARN  vault fill                 session_id=s-1 url=https://e.com/ error_code=X result=success module=mcp n=2',
    );
  });
});
