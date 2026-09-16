/** @module infra/persistence/migrations/sql-enums — renders enum tuples as SQL `CHECK (... IN (...))` lists. */

/** `'a','b','c'` — quoted, comma-separated literal list for a `CHECK (col IN (...))` clause. */
export function sqlIn(values: readonly string[]): string {
  return values.map((v) => `'${v.replaceAll("'", "''")}'`).join(',');
}

/** `col TEXT NOT NULL CHECK (col IN (...))` column fragment. */
export function enumCol(col: string, values: readonly string[], nullable = false): string {
  const nn = nullable ? '' : ' NOT NULL';
  return `${col} TEXT${nn} CHECK (${col} IN (${sqlIn(values)}))`;
}

/** `col INTEGER NOT NULL [DEFAULT d] CHECK (col IN (0,1))` boolean column fragment. */
export function boolCol(col: string, defaultValue?: 0 | 1): string {
  const def = defaultValue === undefined ? '' : ` DEFAULT ${defaultValue}`;
  return `${col} INTEGER NOT NULL${def} CHECK (${col} IN (0,1))`;
}
