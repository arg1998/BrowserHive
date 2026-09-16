/** @module contracts/errors/projections — wire shapes of an error: RFC 9457 problem+json, MCP structured content, WS error payload */
import { z } from 'zod';
import { Retryable } from '../enums/retryable.ts';
import { ErrorCodeSchema } from './registry.ts';

/** Base URL of the generated error docs; `type` is `<ERROR_DOCS_URL>#<code>`. */
export const ERROR_DOCS_URL = 'https://browserhive.ai/docs/errors';

/**
 * RFC 9457 `application/problem+json` body (spec 10 §2.2). `type` links to `docs/errors.md#<code>`;
 * `code`, `retryable`, `hint`, `details` and `request_id` are the BrowserHive extension members.
 */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: ErrorCodeSchema,
  retryable: Retryable,
  hint: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  request_id: z.string().optional(),
});
/** Parsed problem+json body. */
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/**
 * `structuredContent` of an MCP tool result with `isError: true` (spec 10 §2.1). The text content
 * uses the `[CODE] message` text format; this is its structured twin.
 */
export const McpErrorContent = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: Retryable,
  hint: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
/** Parsed MCP structured error content. */
export type McpErrorContent = z.infer<typeof McpErrorContent>;

/** Payload of a WS `kind: 'error'` frame (spec 10 §2.3). */
export const WsErrorPayload = z.object({
  code: ErrorCodeSchema,
  title: z.string(),
  hint: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  request_id: z.string().optional(),
});
/** Parsed WS error payload. */
export type WsErrorPayload = z.infer<typeof WsErrorPayload>;

/**
 * The `type` URL of a code for problem+json.
 *
 * @returns `https://browserhive.ai/docs/errors#<code>`.
 */
export function errorDocsUrl(code: string): string {
  return `${ERROR_DOCS_URL}#${code}`;
}
