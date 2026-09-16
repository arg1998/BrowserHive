/** @module infra/logging/color.test — colour resolution from an injected env. */

import { describe, expect, it } from 'bun:test';
import { ANSI, createPaint, resolveColor, stripAnsi } from './color.ts';

describe('resolveColor', () => {
  it('always/never short-circuit', () => {
    expect(resolveColor('always', { NO_COLOR: '1' }, false)).toBe(true);
    expect(resolveColor('never', { FORCE_COLOR: '1' }, true)).toBe(false);
  });

  it('auto follows FORCE_COLOR, NO_COLOR, TERM=dumb, then TTY (in that precedence)', () => {
    expect(resolveColor('auto', { FORCE_COLOR: '1', NO_COLOR: '1' }, false)).toBe(true);
    expect(resolveColor('auto', { FORCE_COLOR: '0' }, true)).toBe(true);
    expect(resolveColor('auto', { NO_COLOR: '1' }, true)).toBe(false);
    expect(resolveColor('auto', { NO_COLOR: '' }, true)).toBe(true);
    expect(resolveColor('auto', { TERM: 'dumb' }, true)).toBe(false);
    expect(resolveColor('auto', {}, true)).toBe(true);
    expect(resolveColor('auto', {}, false)).toBe(false);
  });
});

describe('createPaint / stripAnsi', () => {
  it('paints only when enabled and text is non-empty', () => {
    expect(createPaint(true)('x', ANSI.red)).toBe(`${ANSI.red}x${ANSI.reset}`);
    expect(createPaint(true)('', ANSI.red)).toBe('');
    expect(createPaint(false)('x', ANSI.red)).toBe('x');
    expect(stripAnsi(createPaint(true)('abc', ANSI.bold, ANSI.blue))).toBe('abc');
  });
});
