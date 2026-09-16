/** @module kernel/secret — opaque `Secret<T>` wrapper that refuses to serialize (spec 05 §7, D-20). */

/** What every serializer sees instead of the wrapped value. */
export const SECRET_PLACEHOLDER = '[secret]';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Holds a sensitive value and hides it from every implicit rendering path: `JSON.stringify`,
 * template literals, `util.inspect`, `console.log`. The only way out is {@link unwrapSecret}.
 *
 * @remarks Redaction by construction is the first line; the scrub pipeline in `redact.ts` is the
 * second. Register the unwrapped value with the `SecretRegistry` when it can echo through page
 * content (vault fills), see spec 10 §9.
 */
export class Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Returns the wrapped value. Name the reason at the call site. */
  reveal(): T {
    return this.#value;
  }

  /** Placeholder for `JSON.stringify`. */
  toJSON(): string {
    return SECRET_PLACEHOLDER;
  }

  /** Placeholder for string coercion. */
  toString(): string {
    return SECRET_PLACEHOLDER;
  }

  /** Placeholder for `util.inspect` / `console.log`. */
  [INSPECT](): string {
    return SECRET_PLACEHOLDER;
  }

  /** Placeholder for `${secret}` and arithmetic coercion. */
  [Symbol.toPrimitive](): string {
    return SECRET_PLACEHOLDER;
  }

  get [Symbol.toStringTag](): string {
    return 'Secret';
  }
}

/** Wraps `value` as a {@link Secret}. */
export function secret<T>(value: T): Secret<T> {
  return new Secret(value);
}

/** Type guard for {@link Secret}. */
export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof Secret;
}

/**
 * Returns the wrapped value of a {@link Secret}, or the value itself when it is not wrapped, so
 * code that accepts `T | Secret<T>` can normalize in one call.
 */
export function unwrapSecret<T>(value: T | Secret<T>): T {
  return value instanceof Secret ? value.reveal() : value;
}
