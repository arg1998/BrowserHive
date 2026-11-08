/** @module interface/mcp/tools/inspection/evaluate-wrap — the IIFE auto-wrap for `evaluate` expressions, decided by a real parse (acorn), never by scanning characters. */

import { type Expression, type Node, type Options, type Program, parse } from 'acorn';

/**
 * Neither Playwright nor Patchright calls a function-valued string (`page.evaluate('() => 1')`
 * answers `undefined`), so `evaluate` wraps a lone function as an IIFE and returns its call result.
 */
const PARSE_OPTIONS: Options = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowAwaitOutsideFunction: true,
};

/**
 * Wraps `expr` as `(<function>)()` when, and only when, the whole input is one function: an arrow
 * or function expression (async and parenthesised forms included), or one function declaration
 * (`function f() {}`, which a page would otherwise only declare). Everything else is returned
 * trimmed and untouched: an already-invoked IIFE, any other expression, several statements, and
 * input that does not parse, so the page reports its own `SyntaxError`.
 *
 * An anonymous `function () {}` is a syntax error as a statement, so a failed parse is retried as
 * a parenthesised expression before the input is given up on. Only the function's own source is
 * kept in the wrap: comments and a `;` around it are dropped, so a trailing `// …` cannot comment
 * out the call.
 */
export function wrapFunctionExpression(expr: string): string {
  const trimmed = expr.trim();
  const fn = loneFunction(trimmed) ?? loneFunctionInParens(trimmed);
  return fn === null ? trimmed : `(${fn})()`;
}

/** The source of the one function `source` consists of, or `null`. */
function loneFunction(source: string): string | null {
  const statement = onlyStatement(source);
  if (statement === null) return null;
  if (statement.type === 'FunctionDeclaration') return sliceOf(source, statement);
  if (statement.type === 'ExpressionStatement' && isFunction(statement.expression)) {
    return sliceOf(source, statement.expression);
  }
  return null;
}

/** `function () {}` / `async function () {}`: parsed as `(\n<source>\n)`, a function expression. */
function loneFunctionInParens(source: string): string | null {
  const wrapped = `(\n${source}\n)`;
  const statement = onlyStatement(wrapped);
  if (statement?.type !== 'ExpressionStatement' || !isFunction(statement.expression)) return null;
  // The function must sit inside the added parentheses; `x) => (x` would borrow them and parse.
  if (statement.expression.start < 2 || statement.expression.end > wrapped.length - 2) return null;
  return sliceOf(wrapped, statement.expression);
}

/** The single top-level statement of `source` parsed as a script, or `null` (none, several, invalid). */
function onlyStatement(source: string): Program['body'][number] | null {
  let program: Program;
  try {
    program = parse(source, PARSE_OPTIONS);
  } catch {
    // Not valid JavaScript: the caller passes the input through and the page reports the error.
    return null;
  }
  return program.body.length === 1 ? (program.body[0] ?? null) : null;
}

function isFunction(node: Expression): boolean {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

function sliceOf(source: string, node: Node): string {
  return source.slice(node.start, node.end);
}
