/** @module domain/site-packs/css-selector.test — the allow-list selector grammar (spec 13 §9.2, §9.10, D-68). */

import { describe, expect, it } from 'bun:test';
import { checkPackSelector } from './css-selector.ts';

const ACCEPTED = [
  'button',
  '*',
  '#logout',
  '.nav__item',
  'a[href]',
  'a[href^="/m/logout"]',
  "form[action*='logout' i]",
  'nav > ul li + li ~ li',
  'button:not(.secondary)',
  'li:nth-child(2n+1)',
  'li:nth-last-of-type(odd)',
  'div:is(.a, .b):where(#c)',
  'section:has(> button.delete)',
  'input:checked, input:disabled, input:enabled, p:empty',
  ':root body',
  'a, b, c, d',
  '[data-test-id=global-nav__me]',
  '.\\31 0',
  'div.-private',
];

const REFUSED: readonly [string, string][] = [
  ['css=button', 'engine prefix'],
  ['xpath=//button', 'engine prefix'],
  ['text=Sign out', 'engine prefix'],
  ['div >> button', '>> chain'],
  ['button:text("Sign out")', 'Playwright text pseudo'],
  ['button:has-text("x")', 'has-text'],
  ['a:text-matches("(a+)+$")', 'regex pseudo'],
  ['button:visible', 'visible'],
  ['div:left-of(#x)', 'layout pseudo'],
  ['div:nth-match(a, 2)', 'nth-match'],
  ['p::before', 'pseudo-element'],
  ['a, b, c, d, e', 'five selectors'],
  ['a:has(b):has(c)', 'two :has'],
  ['a:has(b:has(c))', 'nested :has'],
  ['svg|rect', 'namespace'],
  ['a:hover', 'not allow-listed'],
  ['li:nth-child(2n of .x)', 'nth of S'],
  ['div {}', 'block'],
  ['a[href', 'unclosed attribute'],
  ['a:not(', 'unclosed'],
  ['', 'empty'],
  [', a', 'empty selector'],
  ['a:not(:not(:not(:not(b))))', 'too deep'],
  ['& a', 'nesting'],
  ['a[href="x\ny"]', 'newline in string'],
];

describe('checkPackSelector', () => {
  for (const selector of ACCEPTED) {
    it(`accepts ${selector}`, () => {
      expect(checkPackSelector(selector)).toEqual({ ok: true });
    });
  }
  for (const [selector, why] of REFUSED) {
    it(`refuses ${JSON.stringify(selector)} (${why})`, () => {
      expect(checkPackSelector(selector).ok).toBe(false);
    });
  }
  it('never throws on arbitrary input', () => {
    for (const s of [
      '\\',
      '"',
      "'",
      '[',
      ']',
      '(',
      ')',
      ':',
      '::',
      '#',
      '.',
      '>',
      '+',
      '~',
      '\u0000',
    ]) {
      expect(() => checkPackSelector(s)).not.toThrow();
    }
  });
});
