/** @module styles/affordances.test — guards two affordances: every interactive primitive paints a visible 2px focus ring, and the stacking contract keeps whole-row links clickable over text, against the compiled CSS, the primitives and the shared sources */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compiledCss, topLevelRules } from '../../test/helpers/compiled-css.ts';
import { render, screen } from '../../test/helpers/render.tsx';
import { Button } from '../components/ui/button.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { Toggle } from '../components/ui/toggle.tsx';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group.tsx';

/** Every `.tsx`/`.ts` file under `dir`. */
function sources(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('focus ring', () => {
  it('compiles focus-ring to a solid 2px outline on :focus-visible', async () => {
    const css = await compiledCss(['focus-ring', 'focus-ring-inset']);
    expect(css).toMatch(
      /\.focus-ring \{\s*outline-style: none;\s*&:focus-visible \{\s*outline: var\(--ring-width\) solid var\(--ring\);/,
    );
    expect(css).toMatch(
      /\.focus-ring-inset \{[\s\S]*?outline-offset: calc\(var\(--ring-width\) \* -1\)/,
    );
    expect(css).toContain('--ring-width: 2px;');
  });

  it('keeps an unlayered net so `outline-none focus-visible:outline-2` still paints', async () => {
    const css = await compiledCss(['outline-none', 'focus-visible:outline-2']);
    // Tailwind v4 stores `none` in the variable that `outline-2` reads back: the root cause.
    expect(css).toMatch(/\.outline-none \{\s*--tw-outline-style: none;/);
    expect(css).toMatch(/:focus-visible \{\s*outline-style: var\(--tw-outline-style\);/);
    // Unlayered, so it beats the utility layer for the focused element.
    expect(topLevelRules(css, ':focus-visible')).toContain('--tw-outline-style: solid;');
  });

  it('gives every interactive primitive the focus-ring utility', () => {
    render(
      <>
        <Button>Button</Button>
        <Toggle aria-label="Toggle">T</Toggle>
        <ToggleGroup aria-label="Group" spacing={0}>
          <ToggleGroupItem value="a">Item</ToggleGroupItem>
        </ToggleGroup>
        <Tabs defaultValue="one">
          <TabsList aria-label="Tabs">
            <TabsTrigger value="one">Tab</TabsTrigger>
          </TabsList>
        </Tabs>
        <Switch aria-label="Switch" />
        <Checkbox aria-label="Checkbox" />
      </>,
    );
    for (const control of [
      screen.getByRole('button', { name: 'Button' }),
      screen.getByRole('button', { name: 'Toggle' }),
      screen.getByRole('button', { name: 'Item' }),
      screen.getByRole('tab', { name: 'Tab' }),
      screen.getByRole('switch', { name: 'Switch' }),
      screen.getByRole('checkbox', { name: 'Checkbox' }),
    ]) {
      expect(control.className.split(/\s+/)).toContain('focus-ring');
    }
  });

  it('never pairs a reset outline with an outline width in shell and shared code', () => {
    const root = resolve(import.meta.dir, '..');
    const broken: string[] = [];
    for (const file of [...sources(join(root, 'components')), ...sources(join(root, 'app'))]) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (
          /\boutline-(none|hidden)\b/.test(line) &&
          /focus-visible:outline-\d/.test(line) &&
          !/focus-visible:outline-solid/.test(line)
        ) {
          broken.push(`${file}:${index + 1}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('row link stacking', () => {
  it('puts the row link above text and real controls above the link', async () => {
    const css = await compiledCss([]);
    const link = /\[data-row-link-scope\] \[data-row-link\] \{\s*z-index: 1;/;
    expect(css).toMatch(link);
    const lifted =
      /\[data-row-link-scope\]\s*:is\(([^)]*)\):not\(\[data-row-link\]\) \{\s*position: relative;\s*z-index: 2;/;
    const match = lifted.exec(css);
    expect(match).not.toBeNull();
    const selectors = (match?.[1] ?? '').split(',').map((s) => s.trim());
    expect(selectors).toContain('button');
    expect(selectors).toContain('a');
    expect(selectors).toContain('[data-interactive]');
    // Display text never climbs above the link.
    for (const text of ['span', 'label', 'p', 'div', 'time']) expect(selectors).not.toContain(text);
  });
});
