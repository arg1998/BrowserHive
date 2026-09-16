/** @module dashboard/test/helpers/compiled-css — compile `styles/globals.css` with Tailwind for a set of candidate classes, so tests can assert the real cascade rules (package CSS imports such as fonts are skipped) */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compile } from 'tailwindcss';

const PACKAGE_IMPORT = /^@import "(?!tailwindcss"|\.\/).*$/gm;
const ENTRY = resolve(import.meta.dir, '../../src/styles/globals.css');

/** The CSS Tailwind emits for `globals.css` plus `candidates`. */
export async function compiledCss(candidates: readonly string[]): Promise<string> {
  const load = async (id: string, base: string) => {
    const path =
      id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : resolve(base, id);
    return {
      path,
      base: dirname(path),
      content: readFileSync(path, 'utf8').replace(PACKAGE_IMPORT, ''),
    };
  };
  const compiler = await compile(readFileSync(ENTRY, 'utf8').replace(PACKAGE_IMPORT, ''), {
    base: dirname(ENTRY),
    loadStylesheet: load,
  });
  return compiler.build([...candidates]);
}

/** Top-level (unlayered) rule bodies for `selector`, ignoring anything nested in `@layer`/`@media`. */
export function topLevelRules(css: string, selector: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let header = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        header = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (header === selector) out.push(css.slice(start, i).trim());
        start = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      start = i + 1;
    }
  }
  return out;
}
