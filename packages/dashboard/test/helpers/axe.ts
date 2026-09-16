/** @module dashboard/test/helpers/axe — run axe-core against a rendered container; rules needing real layout are skipped in happy-dom */
import '../setup.ts';
import { expect } from 'bun:test';
import axe from 'axe-core';

/** Assert zero violations. `color-contrast` needs real layout and is verified by the `/theme` page instead. */
export async function expectNoA11yViolations(
  container: Element,
  options: { readonly disable?: readonly string[] } = {},
): Promise<void> {
  const results = await axe.run(container, {
    rules: {
      ...Object.fromEntries((options.disable ?? []).map((id) => [id, { enabled: false }])),
      'color-contrast': { enabled: false },
      region: { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
    },
    resultTypes: ['violations'],
  });
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  );
  if (summary.length > 0) throw new Error(`axe violations:\n${summary.join('\n')}`);
  expect(summary).toEqual([]);
}
