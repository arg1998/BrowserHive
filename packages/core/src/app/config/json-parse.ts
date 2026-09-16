/** @module app/config/json-parse — strict JSON parser that reports line and column on failure (spec 08 §3: plain JSON, no comments, no trailing commas) */
import { err, ok, type Result } from '../../kernel/result.ts';

/** A JSON value as parsed from a config file. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Position-bearing parse failure (1-based line and column). */
export interface JsonParseError {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

class JsonFailure extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'JsonFailure';
  }
}

const WHITESPACE = /[ \t\r\n]/;
const STRING_RE = /^"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/;
const CONTROL_CHAR_RE = /[\p{Cc}]/u;
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

class Parser {
  private index = 0;
  constructor(private readonly text: string) {}

  parseDocument(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index < this.text.length) this.fail(`unexpected ${this.describe()}`);
    return value;
  }

  private fail(message: string): never {
    throw new JsonFailure(message, this.index);
  }

  private describe(): string {
    if (this.index >= this.text.length) return 'end of input';
    return `token '${this.text.charAt(this.index)}'`;
  }

  private peek(): string {
    return this.text.charAt(this.index);
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && WHITESPACE.test(this.peek())) this.index += 1;
  }

  private parseValue(): JsonValue {
    const char = this.peek();
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return this.parseString();
    if (char === '-' || (char >= '0' && char <= '9')) return this.parseNumber();
    if (this.text.startsWith('true', this.index)) return this.literal('true', true);
    if (this.text.startsWith('false', this.index)) return this.literal('false', false);
    if (this.text.startsWith('null', this.index)) return this.literal('null', null);
    if (char === '/') this.fail('comments are not allowed');
    if (char === "'") this.fail('strings must use double quotes');
    return this.fail(`unexpected ${this.describe()}`);
  }

  private literal<T extends JsonValue>(word: string, value: T): T {
    this.index += word.length;
    return value;
  }

  private parseObject(): { readonly [key: string]: JsonValue } {
    const out: Record<string, JsonValue> = {};
    this.index += 1;
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.index += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        this.fail(
          this.peek() === '}'
            ? 'trailing commas are not allowed'
            : `expected a quoted key, got ${this.describe()}`,
        );
      }
      const name = this.parseString();
      this.skipWhitespace();
      if (this.peek() !== ':') this.fail(`expected ':', got ${this.describe()}`);
      this.index += 1;
      this.skipWhitespace();
      out[name] = this.parseValue();
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === '}') {
        this.index += 1;
        return out;
      }
      this.fail(`expected ',' or '}', got ${this.describe()}`);
    }
  }

  private parseArray(): readonly JsonValue[] {
    const out: JsonValue[] = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.index += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() === ']') this.fail('trailing commas are not allowed');
      out.push(this.parseValue());
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === ']') {
        this.index += 1;
        return out;
      }
      this.fail(`expected ',' or ']', got ${this.describe()}`);
    }
  }

  private parseString(): string {
    const match = STRING_RE.exec(this.text.slice(this.index));
    if (match === null) this.fail('unterminated or malformed string');
    const raw = match[0];
    if (CONTROL_CHAR_RE.test(raw)) this.fail('control character in string');
    this.index += raw.length;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : this.fail('malformed string');
  }

  private parseNumber(): number {
    const match = NUMBER_RE.exec(this.text.slice(this.index));
    if (match === null) this.fail('malformed number');
    this.index += match[0].length;
    return Number(match[0]);
  }
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Parse strict JSON. Unlike `JSON.parse`, failures carry the 1-based line and column.
 *
 * @returns `ok(value)` or `err({ line, column, message })`.
 */
export function parseJson(text: string): Result<JsonValue, JsonParseError> {
  try {
    return ok(new Parser(text).parseDocument());
  } catch (error) {
    if (error instanceof JsonFailure) {
      return err({ ...positionOf(text, error.offset), message: error.message });
    }
    throw error;
  }
}

/**
 * Narrow a JSON value to an object.
 *
 * @returns `true` for a plain object (not an array, not null).
 */
export function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
