/** @module domain/site-packs/css-selector — the allow-list CSS grammar a site pack's selectors must follow (spec 13 §9.2, §9.10, D-68): a small recursive-descent check, no third-party parser, no evaluation. */

import { CSS_PSEUDO_ALLOWLIST } from '@browserhive/contracts/site-packs';

/** Most complex selectors in one top-level list (spec 13 §9.10). */
export const MAX_SELECTORS_PER_LIST = 4;
/** Most `:has(` in one selector (spec 13 §9.10). */
export const MAX_HAS = 1;
/** Deepest nesting of functional pseudo-classes. */
const MAX_DEPTH = 3;

const FUNCTIONAL_LISTS: ReadonlySet<string> = new Set(['not', 'is', 'where', 'has']);
const NTH: ReadonlySet<string> = new Set([
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
]);
const ALLOWED: ReadonlySet<string> = new Set(CSS_PSEUDO_ALLOWLIST);
const NTH_ARG = /^\s*(?:odd|even|[+-]?\d+|[+-]?\d*n(?:\s*[+-]\s*\d+)?)\s*$/i;
const ATTR_OPS = ['~=', '|=', '^=', '$=', '*=', '='] as const;

/** Why a selector was refused. */
export type SelectorCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

class Refused extends Error {}

/**
 * Checks `selector` against the pack grammar: type or `*`, `#id`, `.class`, `[attr]` and
 * `[attr op value i|s]`, the combinators (descendant, `>`, `+`, `~`), the pseudo-classes of
 * `CSS_PSEUDO_ALLOWLIST` (`:not`/`:is`/`:where`/`:has` take a nested list, `:nth-*` take `An+B`,
 * `odd` or `even`), at most {@link MAX_SELECTORS_PER_LIST} selectors and {@link MAX_HAS} `:has(`.
 * Everything else is refused: pseudo-elements, Playwright's extensions (`:text*`, `:has-text`,
 * `:visible`, layout pseudo-classes), engine prefixes (`css=`, `xpath=`, `text=`), `>>` chains,
 * namespaces and nesting. Never throws.
 */
export function checkPackSelector(selector: string): SelectorCheck {
  const parser = new SelectorParser(selector);
  try {
    const count = parser.list(0, false);
    parser.end();
    if (count > MAX_SELECTORS_PER_LIST) {
      return { ok: false, reason: `more than ${MAX_SELECTORS_PER_LIST} selectors in the list` };
    }
    if (parser.hasCount > MAX_HAS) return { ok: false, reason: 'more than one :has(' };
    return { ok: true };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.message };
    return { ok: false, reason: 'unparseable selector' };
  }
}

class SelectorParser {
  private pos = 0;
  hasCount = 0;

  constructor(private readonly text: string) {}

  /** A comma-separated list of complex selectors; returns how many. */
  list(depth: number, relative: boolean): number {
    let count = 0;
    for (;;) {
      this.ws();
      this.complex(depth, relative);
      count += 1;
      this.ws();
      if (this.peek() !== ',') return count;
      this.pos += 1;
    }
  }

  end(): void {
    this.ws();
    if (this.pos < this.text.length) throw new Refused(`unexpected '${this.peek()}'`);
  }

  private complex(depth: number, relative: boolean): void {
    if (relative && this.combinator()) this.ws();
    this.compound(depth);
    for (;;) {
      const before = this.pos;
      const sawSpace = this.ws();
      if (this.combinator()) {
        this.ws();
        this.compound(depth);
        continue;
      }
      if (sawSpace && this.startsCompound()) {
        this.compound(depth);
        continue;
      }
      this.pos = before;
      return;
    }
  }

  private combinator(): boolean {
    const c = this.peek();
    if (c === '>' || c === '+' || c === '~') {
      if (c === '>' && this.text[this.pos + 1] === '>')
        throw new Refused("'>>' chains are refused");
      this.pos += 1;
      return true;
    }
    return false;
  }

  private startsCompound(): boolean {
    const c = this.peek();
    return (
      c === '*' ||
      c === '#' ||
      c === '.' ||
      c === '[' ||
      c === ':' ||
      isIdentStart(this.text, this.pos)
    );
  }

  private compound(depth: number): void {
    let parts = 0;
    if (this.peek() === '*') {
      this.pos += 1;
      parts += 1;
    } else if (isIdentStart(this.text, this.pos)) {
      this.ident();
      parts += 1;
    }
    if (this.peek() === '|') throw new Refused('namespaces are refused');
    for (;;) {
      const c = this.peek();
      if (c === '#' || c === '.') {
        this.pos += 1;
        this.ident();
      } else if (c === '[') {
        this.attribute();
      } else if (c === ':') {
        this.pseudo(depth);
      } else {
        break;
      }
      parts += 1;
    }
    if (parts === 0)
      throw new Refused(
        this.pos >= this.text.length ? 'empty selector' : `unexpected '${this.peek()}'`,
      );
  }

  private attribute(): void {
    this.pos += 1; // [
    this.ws();
    this.ident();
    this.ws();
    if (this.peek() === ']') {
      this.pos += 1;
      return;
    }
    const op = ATTR_OPS.find((o) => this.text.startsWith(o, this.pos));
    if (op === undefined) throw new Refused('bad attribute selector');
    this.pos += op.length;
    this.ws();
    const c = this.peek();
    if (c === '"' || c === "'") this.string(c);
    else this.ident();
    this.ws();
    const flag = this.peek()?.toLowerCase();
    if (flag === 'i' || flag === 's') {
      this.pos += 1;
      this.ws();
    }
    if (this.peek() !== ']') throw new Refused('bad attribute selector');
    this.pos += 1;
  }

  private pseudo(depth: number): void {
    this.pos += 1; // :
    if (this.peek() === ':') throw new Refused('pseudo-elements are refused');
    const name = this.ident().toLowerCase();
    if (!ALLOWED.has(name)) throw new Refused(`pseudo-class ':${name}' is not allowed`);
    const functional = FUNCTIONAL_LISTS.has(name) || NTH.has(name);
    if (!functional) {
      if (this.peek() === '(') throw new Refused(`':${name}' takes no argument`);
      return;
    }
    if (this.peek() !== '(') throw new Refused(`':${name}' needs an argument`);
    this.pos += 1;
    if (NTH.has(name)) {
      const close = this.text.indexOf(')', this.pos);
      if (close < 0) throw new Refused('unclosed (');
      if (!NTH_ARG.test(this.text.slice(this.pos, close)))
        throw new Refused(`bad ':${name}' argument`);
      this.pos = close + 1;
      return;
    }
    if (depth + 1 > MAX_DEPTH) throw new Refused('nested too deeply');
    if (name === 'has') this.hasCount += 1;
    this.list(depth + 1, name === 'has');
    this.ws();
    if (this.peek() !== ')') throw new Refused('unclosed (');
    this.pos += 1;
  }

  private ident(): string {
    const start = this.pos;
    if (this.peek() === '-') this.pos += 1;
    if (this.peek() === '-') this.pos += 1;
    if (!this.identChar(true)) throw new Refused('expected a name');
    while (this.identChar(false)) {
      // consumed
    }
    return this.text.slice(start, this.pos);
  }

  /** Consumes one name character (or escape); `first` excludes digits. */
  private identChar(first: boolean): boolean {
    const c = this.peek();
    if (c === undefined) return false;
    if (c === '\\') {
      const next = this.text[this.pos + 1];
      if (next === undefined || next === '\n' || next === '\r' || next === '\f') {
        throw new Refused('bad escape');
      }
      const hex = /^[0-9a-fA-F]{1,6} ?/.exec(this.text.slice(this.pos + 1));
      this.pos += 1 + (hex === null ? 1 : hex[0].length);
      return true;
    }
    if (/[A-Za-z_ -￿]/.test(c) || c === '-' || (!first && /[0-9]/.test(c))) {
      if (first && c === '-') return false;
      this.pos += 1;
      return true;
    }
    return false;
  }

  private string(quote: string): void {
    this.pos += 1;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === '\n' || c === '\r' || c === '\f') throw new Refused('newline in string');
      if (c === '\\') {
        this.pos += 2;
        continue;
      }
      this.pos += 1;
      if (c === quote) return;
    }
    throw new Refused('unclosed string');
  }

  /** Skips white space; true when any was skipped. */
  private ws(): boolean {
    const start = this.pos;
    while (/[ \t\n\r\f]/.test(this.text[this.pos] ?? '')) this.pos += 1;
    return this.pos > start;
  }

  private peek(): string | undefined {
    return this.text[this.pos];
  }
}

function isIdentStart(text: string, pos: number): boolean {
  const c = text[pos];
  if (c === undefined) return false;
  if (c === '-') {
    const n = text[pos + 1];
    return n !== undefined && (n === '-' || n === '\\' || /[A-Za-z_ -￿]/.test(n));
  }
  return c === '\\' || /[A-Za-z_ -￿]/.test(c);
}
