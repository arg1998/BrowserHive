/** @module contracts/errors/registry — the single error registry (D-07): every code, its projection facts and details schema */
import { z } from 'zod';
import type { HttpAuditCode } from './audit.ts';
import { AUDIT_ERRORS, WARNING_ERRORS } from './codes-audit-warning.ts';
import { AUTH_ERRORS, TRANSPORT_ERRORS } from './codes-auth-transport.ts';
import { BOOT_ERRORS } from './codes-boot.ts';
import { PAGE_ERRORS } from './codes-page.ts';
import { SERVICE_ERRORS } from './codes-service.ts';
import { SESSION_ERRORS } from './codes-session.ts';
import type { ErrorSpecShape } from './spec.ts';

const REGISTRY = {
  ...SESSION_ERRORS,
  ...PAGE_ERRORS,
  ...SERVICE_ERRORS,
  ...BOOT_ERRORS,
  ...AUTH_ERRORS,
  ...TRANSPORT_ERRORS,
  ...AUDIT_ERRORS,
  ...WARNING_ERRORS,
} as const;

/** Compile-time guarantee that every registry key equals its entry's `code`. */
type KeyedByCode<R> = { readonly [K in keyof R]: { readonly code: K } };

/**
 * Every error code with its HTTP status, category, retryability, title, public message template,
 * hint, details schema and docs prose. Keys are the codes; entries keep precise `details` types.
 */
export const ERROR_REGISTRY: typeof REGISTRY = REGISTRY satisfies KeyedByCode<typeof REGISTRY> &
  Readonly<Record<string, ErrorSpecShape>>;

/** Union of every registered error code. */
export type ErrorCode = keyof typeof ERROR_REGISTRY;

/** The precisely typed registry entry for a code. */
export type ErrorSpec<C extends ErrorCode = ErrorCode> = (typeof ERROR_REGISTRY)[C];

/** The structured details type of a code (`z.infer` of its details schema). */
export type ErrorDetails<C extends ErrorCode> = z.infer<ErrorSpec<C>['details']>;

/** Any value that can land in `tool_calls.error_code`: a registry code or an `HTTP_<n>` audit code. */
export type AuditCode = ErrorCode | HttpAuditCode;

/**
 * Type guard for registry codes.
 *
 * @returns `true` when `value` is a key of {@link ERROR_REGISTRY}.
 */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_REGISTRY, value);
}

/** Every code in registry order (session, page, service, boot, auth, transport, audit, warning). */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(
  Object.keys(ERROR_REGISTRY).filter(isErrorCode),
);

/** Zod schema accepting any registered code (used by problem+json, MCP and WS projections). */
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/**
 * Look up a registry entry.
 *
 * @returns The entry for `code`.
 */
export function errorSpec<C extends ErrorCode>(code: C): ErrorSpec<C> {
  return ERROR_REGISTRY[code];
}

/**
 * Codes of one category, in registry order.
 *
 * @returns The codes whose `category` matches.
 */
export function codesInCategory(category: ErrorSpec['category']): readonly ErrorCode[] {
  return ERROR_CODES.filter((code) => ERROR_REGISTRY[code].category === category);
}
