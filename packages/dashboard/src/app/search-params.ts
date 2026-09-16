/** @module app/search-params — URL search serialisation: arrays of plain values as readable comma lists (`?level=warn,error`), everything else as TanStack's JSON default; JSON-array list params still parse */
import { defaultParseSearch, stringifySearchWith } from '@tanstack/react-router';

/** Can `value` be written as one comma-list item and read back by `csvParam`? */
function isCsvItem(value: unknown): value is string | number | boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  return typeof value === 'string' && value !== '' && !value.includes(',');
}

/** Same as TanStack's default for anything that is not a list. */
const jsonStringify = stringifySearchWith(JSON.stringify, JSON.parse);

/**
 * Stringify a search object. Non-empty arrays whose items are plain values without commas become
 * `a,b,c`, which every list param reads through `csvParam`; other values keep the JSON default.
 * Key order is preserved.
 */
export function stringifySearch(search: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value) && value.length > 0 && value.every(isCsvItem)) {
      const list = encodeURIComponent(value.map(String).join(',')).replaceAll('%2C', ',');
      pairs.push(`${encodeURIComponent(key)}=${list}`);
    } else {
      // `?k=v`, or '' for undefined values the default drops.
      const one = jsonStringify({ [key]: value });
      if (one !== '') pairs.push(one.slice(1));
    }
  }
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/** Parse a search string: TanStack's JSON-aware default (numbers, booleans, JSON arrays). */
export const parseSearch: (searchStr: string) => Record<string, unknown> = defaultParseSearch;
