/** @module kernel/errors/app-error — the one throwable error type; codes come from the contracts registry (D-07). */

import {
  ERROR_REGISTRY,
  type ErrorCode,
  type ErrorDetails,
  type Retryable,
} from '@browserhive/contracts/errors';

/** Options accepted by the `AppError` constructor. */
export interface AppErrorOptions {
  /** Private message (may contain host paths, third-party prose). Defaults to `publicMessage`. */
  readonly message?: string;
  /** Message safe for any audience. Defaults to the registry title. */
  readonly publicMessage?: string;
  /** Always set when wrapping another error. */
  readonly cause?: unknown;
  /** Overrides the registry's retryability for this instance. */
  readonly retryable?: Retryable;
}

/**
 * Typed application error. `code` selects a registry entry that fixes the HTTP status,
 * category, default retryability, title and hint. `details` follows the entry's details schema.
 */
export class AppError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly details: ErrorDetails<C>;
  readonly publicMessage: string;
  readonly hint: string | undefined;
  readonly retryable: Retryable;
  readonly httpStatus: number;
  override readonly cause: unknown;

  constructor(code: C, details: ErrorDetails<C>, opts: AppErrorOptions = {}) {
    const spec = ERROR_REGISTRY[code];
    const publicMessage = opts.publicMessage ?? spec.title;
    super(opts.message ?? publicMessage);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.publicMessage = publicMessage;
    this.hint = spec.hint;
    this.retryable = opts.retryable ?? spec.retryable;
    this.httpStatus = spec.httpStatus;
    this.cause = opts.cause;
  }

  /** Public projection (no private message, no cause). */
  toJSON(): {
    code: C;
    message: string;
    hint?: string;
    details: ErrorDetails<C>;
    retryable: Retryable;
  } {
    return {
      code: this.code,
      message: this.publicMessage,
      ...(this.hint !== undefined && { hint: this.hint }),
      details: this.details,
      retryable: this.retryable,
    };
  }
}

/** Type guard for `AppError`, optionally narrowed to one code. */
export function isAppError<C extends ErrorCode>(value: unknown, code?: C): value is AppError<C> {
  return value instanceof AppError && (code === undefined || value.code === code);
}

/** Factory alias with typed details. */
export function errorFrom<C extends ErrorCode>(
  code: C,
  details: ErrorDetails<C>,
  opts?: AppErrorOptions,
): AppError<C> {
  return new AppError(code, details, opts);
}

/** Exhaustiveness guard for `switch` over unions (spec 05 §2.3). */
export function assertNever(value: never, detail?: string): never {
  throw new AppError(
    'INTERNAL_ERROR',
    { ref: 'assert-never' },
    { message: `unhandled variant ${detail ?? JSON.stringify(value)}` },
  );
}

/** Narrowing helper replacing non-null assertions: throws `INTERNAL_ERROR` when `value` is nullish. */
export function expect<T>(value: T | null | undefined, why: string): T {
  if (value === null || value === undefined) {
    throw new AppError('INTERNAL_ERROR', { ref: 'expect' }, { message: `expected value: ${why}` });
  }
  return value;
}
