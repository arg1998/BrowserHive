/** @module interface/mcp/tools/inspection/evaluate-wrap — the IIFE wrapping heuristic for `evaluate` expressions. */

/**
 * If `expr` looks like a function definition, wraps it as an IIFE so `page.evaluate(expression)`
 * returns the call result rather than the function object (mirrors Playwright's own heuristic).
 * Detected: `() => x`, `(a, b) => x`, `x => x`, `async` variants, `function …`, `async function …`.
 * An already-invoked IIFE (`(() => {...})()`) is returned untouched — wrapping again would call the
 * IIFE's non-function return value.
 */
export function wrapFunctionExpression(expr: string): string {
  const trimmed = expr.trim();
  if (isAlreadyInvoked(trimmed)) return trimmed;
  const looksLikeFunction =
    /^(async\s+)?\([^)]*\)\s*=>/.test(trimmed) ||
    /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(trimmed) ||
    /^(async\s+)?function\b/.test(trimmed);
  return looksLikeFunction ? `(${trimmed})()` : trimmed;
}

/** True when `trimmed` is a parenthesised expression immediately called. */
function isAlreadyInvoked(trimmed: string): boolean {
  if (!trimmed.startsWith('(')) return false;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0)
        return trimmed
          .slice(i + 1)
          .trimStart()
          .startsWith('(');
    }
  }
  return false;
}
