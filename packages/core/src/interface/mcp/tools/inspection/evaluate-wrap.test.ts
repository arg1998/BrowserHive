/** @module interface/mcp/tools/inspection/evaluate-wrap.test — the auto-wrap parses the expression: only a lone function expression is wrapped (#56). */

import { describe, expect, it } from 'bun:test';
import { wrapFunctionExpression } from './evaluate-wrap.ts';

describe('wrapFunctionExpression leaves an already-invoked IIFE untouched', () => {
  it.each([
    ["(() => { const s = 'start('; return s.length; })()"],
    ['(() => { const s = ")"; return s; })()'],
    ['(() => { const s = `(`; return s; })()'],
    ['(() => /\\(/.test("a(b"))()'],
    ['(() => {\n  // (\n  return 1;\n})()'],
    ['(() => { /* ( */ return 1; })()'],
    ["(function () { return ')'; })()"],
    ['(async () => { await 0; return "(("; })()'],
    ['(() => 1)()'],
  ])('%s', (expr) => {
    expect(wrapFunctionExpression(expr)).toBe(expr);
  });
});

describe('wrapFunctionExpression wraps a lone function expression', () => {
  it.each([
    ['() => 1', '(() => 1)()'],
    ['x => x', '(x => x)()'],
    ['(a, b) => a + b', '((a, b) => a + b)()'],
    ['async () => 2', '(async () => 2)()'],
    ['async x => x', '(async x => x)()'],
    ['function(){}', '(function(){})()'],
    ['async function(){}', '(async function(){})()'],
    ['function () { return 3 }', '(function () { return 3 })()'],
    ['async function f() {}', '(async function f() {})()'],
    ['(() => 1)', '(() => 1)()'],
    ['  () => 1  ', '(() => 1)()'],
    ['() => 1;', '(() => 1)()'],
    [
      "() => { const s = 'start('; return s.length; }",
      "(() => { const s = 'start('; return s.length; })()",
    ],
  ])('%s', (expr, wrapped) => {
    expect(wrapFunctionExpression(expr)).toBe(wrapped);
  });

  it('drops a trailing line comment instead of commenting out the call', () => {
    expect(wrapFunctionExpression('() => 1 // the answer')).toBe('(() => 1)()');
  });
});

describe('wrapFunctionExpression leaves everything else untouched', () => {
  it.each([
    ['1 + 1'],
    ['document.title'],
    ['const a = 1; a + 1'],
    ['(() => 1)(); (() => 2)()'],
    ['() => 1, 2'],
    ['await fetch("/x")'],
    ["fetch('http://127.0.0.1:1/x')"],
    ['null.x'],
  ])('%s', (expr) => {
    expect(wrapFunctionExpression(expr)).toBe(expr.trim());
  });

  it('passes invalid syntax through so the page reports its own SyntaxError', () => {
    for (const expr of [
      "(() => { const s = 'start('; return s.length; })(",
      '() =>',
      '{{{',
      ')(',
      'x) => (x',
    ]) {
      expect(wrapFunctionExpression(expr)).toBe(expr);
    }
  });
});
