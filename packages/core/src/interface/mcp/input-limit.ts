/** @module interface/mcp/input-limit — the cap on array elements and object members in one tool call's arguments (spec 02 §2.3). */

/**
 * Most array elements plus object members one call's arguments may hold, counted at every depth.
 * Well above the largest real input (a full browser cookie jar for `set_cookies`: about 3,300
 * cookies of about 9 fields), far below what exhausts memory while validating
 * (GHSA-46jr-4wx8-v453, D-46).
 */
export const MAX_TOOL_INPUT_ELEMENTS = 100_000;

/**
 * True when `value` holds more than `max` array elements and object members. Iterative, and stops
 * counting at `max + 1`, so neither deep nesting nor a huge payload costs more than the cap.
 */
export function exceedsInputElements(value: unknown, max = MAX_TOOL_INPUT_ELEMENTS): boolean {
  let count = 0;
  const stack: object[] = [];
  const visit = (child: unknown): boolean => {
    count += 1;
    if (child !== null && typeof child === 'object') stack.push(child);
    return count > max;
  };
  if (value !== null && typeof value === 'object') stack.push(value);
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (Array.isArray(node)) {
      for (const child of node) if (visit(child)) return true;
    } else {
      // `for…in` over own keys: no copy of a huge object's keys is made before the cap applies.
      for (const key in node) {
        if (Object.hasOwn(node, key) && visit(Object.getOwnPropertyDescriptor(node, key)?.value)) {
          return true;
        }
      }
    }
  }
  return false;
}
