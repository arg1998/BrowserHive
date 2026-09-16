/** @module components/shared/chart-colors.test — every chart paints with tokens that `tokens.css` defines in both themes (a missing variable renders marks invisible or black) */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '../../../test/helpers/render.tsx';
import { ActivityChart } from '../../features/overview/components/ActivityChart.tsx';
import { CHART_INK, type ChartColor, chartVar } from './chart-frame.tsx';

const TOKENS = readFileSync(join(import.meta.dir, '../../styles/tokens.css'), 'utf8');

/** Custom properties declared directly inside a top-level selector block (not `@theme`). */
function declaredIn(selector: string): ReadonlySet<string> {
  const start = TOKENS.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = TOKENS.slice(start, TOKENS.indexOf('\n}', start));
  return new Set([...body.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1] ?? ''));
}

const LIGHT = declaredIn(':root');
const DARK = declaredIn(':root[data-theme="dark"]');

function varNames(value: string): string[] {
  return [...value.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] ?? '');
}

describe('chart colour tokens', () => {
  it('chartVar and CHART_INK reference variables defined in light and dark', () => {
    const slots: ChartColor[] = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6'];
    for (const ref of [...slots.map(chartVar), ...Object.values(CHART_INK)].flatMap(varNames)) {
      expect({ ref, light: LIGHT.has(ref), dark: DARK.has(ref) }).toEqual({
        ref,
        light: true,
        dark: true,
      });
    }
  });

  it('activity chart marks use chart colour utilities backed by tokens in both themes', () => {
    const points = [0, 1, 2].map((i) => ({
      ts: i * 60_000,
      end: (i + 1) * 60_000,
      ok: 3 + i,
      errors: i,
      sessions_started: 1,
      sessions_closed: 0,
      label: `b${i}`,
    }));
    const { container } = render(<ActivityChart points={points} bucketMs={60_000} />);
    const html = container.innerHTML;
    // Session-start markers use the amber slot: chart-2 (green) vs chart-5 (red) fails deutan CVD separation.
    for (const slot of ['chart-1', 'chart-5', 'chart-3']) {
      expect(html).toContain(`bg-${slot}`);
      expect({ slot, light: LIGHT.has(`--${slot}`), dark: DARK.has(`--${slot}`) }).toEqual({
        slot,
        light: true,
        dark: true,
      });
    }
  });
});
