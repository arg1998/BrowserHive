/** @module kernel/result — minimal Result type for pure parse/classify/decide functions (spec 05 §2.5). */

/** A successful outcome carrying `value`. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** A failed outcome carrying `error`. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Either `Ok<T>` or `Err<E>`. Functions returning `Result` never throw for expected non-matches. */
export type Result<T, E> = Ok<T> | Err<E>;

/** Builds an `Ok`. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Builds an `Err`. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
