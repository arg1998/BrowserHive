/** @module app/site-packs/element-targets — what an interaction tool would act on, and whether that is a guarded control (spec 13 §9.3 the tool layer): locators only, pack selectors queried through `locator('css=…')` / `getByRole`, never evaluated. */

import type { PackElementGuard } from '@browserhive/contracts/site-packs';
import type { Locator, Page } from 'patchright';

/** The tools whose target is checked against element guards. */
export const ELEMENT_GUARD_TOOLS: ReadonlySet<string> = new Set([
  'click',
  'hover',
  'select_option',
  'drag_and_drop',
  'fill',
  'type_text',
  'press_key',
]);

/** The controls a form submits through (implicit submission and an explicit submit). */
const SUBMIT_CONTROLS =
  'css=button:not([type]), button[type="submit" i], input[type="submit" i], input[type="image" i]';

function text(args: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = args[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The submit controls of the form holding `field`. */
function submitControlsOf(field: Locator): Locator {
  return field.locator('xpath=ancestor::form[1]').locator(SUBMIT_CONTROLS);
}

/**
 * The elements `tool` would act on in `page`: the selector(s) it names; `drag_and_drop` both ends;
 * `type_text` with a newline anywhere in the text (and `press_key` of `Enter`) also its form's submit
 * controls; `press_key` without a selector the focused element (`:focus`, read by the driver's
 * isolated query, never the page's script).
 */
export function elementTargets(
  page: Page,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): readonly Locator[] {
  const at = (field: string): Locator[] => {
    const selector = text(args, field);
    return selector === undefined ? [] : [page.locator(selector)];
  };
  switch (tool) {
    case 'click':
    case 'hover':
    case 'select_option':
    case 'fill':
      return at('selector');
    case 'drag_and_drop':
      return [...at('source_selector'), ...at('target_selector')];
    case 'type_text': {
      const field = at('selector');
      // Any newline submits, not only a trailing one (review #83 C-L2: `a\nb` submits too).
      const submits = /[\r\n]/.test(text(args, 'text') ?? '');
      return submits ? [...field, ...field.map(submitControlsOf)] : field;
    }
    case 'press_key': {
      const field =
        text(args, 'selector') === undefined ? [page.locator('css=*:focus')] : at('selector');
      const enter = text(args, 'key')?.toLowerCase() === 'enter';
      return enter ? [...field, ...field.map(submitControlsOf)] : field;
    }
    default:
      return [];
  }
}

/** The guarded control(s) of `guard` in `page`. */
export function guardLocator(page: Page, guard: PackElementGuard): Locator {
  const target = guard.target;
  return 'selector' in target
    ? page.locator(`css=${target.selector}`)
    : page.getByRole(target.role, { name: target.name });
}

/**
 * True when some element of `target` is a guarded control or lies inside one: the intersection
 * of the target with the guard's elements and their descendants (`and`/`or`, one count).
 */
export async function insideGuard(guard: Locator, target: Locator): Promise<boolean> {
  return (await target.and(guard.or(guard.locator('css=*'))).count()) > 0;
}
