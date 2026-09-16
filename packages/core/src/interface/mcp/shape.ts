/** @module interface/mcp/shape — projections of tool outcomes onto MCP `CallToolResult`s: `[CODE] message` + `McpErrorContent`, JSON text + `structuredContent`, redaction walk (spec 02 §2.4, D-07). */

import { ERROR_REGISTRY, type McpErrorContent, renderMessage } from '@browserhive/contracts/errors';
import type { z } from 'zod';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { ContentBlock, ToolResult } from './definition.ts';

/** The subset of MCP `CallToolResult` the dispatcher produces. */
export interface ShapedResult {
  readonly content: ContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  /** Carries the structured error (`ERROR_META_KEY`) on error results. */
  readonly _meta?: Record<string, unknown>;
  readonly isError?: true;
  /** Index signature the SDK's result type requires. */
  readonly [key: string]: unknown;
}

/**
 * The public message of an `AppError`: its explicit `publicMessage`, or — when the thrower left
 * the registry title in place — the registry message template rendered from `details` (only when
 * every slot resolved).
 */
export function publicMessageOf(error: AppError): string {
  const spec = ERROR_REGISTRY[error.code];
  if (error.publicMessage !== spec.title) return error.publicMessage;
  const details: unknown = error.details;
  const record =
    typeof details === 'object' && details !== null
      ? Object.fromEntries(Object.entries(details))
      : {};
  const rendered = renderMessage(spec.message, record);
  return /\{[a-z_]+\}/.test(rendered) ? error.publicMessage : rendered;
}

/** Wraps any thrown value as an `AppError`; unknown values become `INTERNAL_ERROR { ref }` with a private cause. */
export function toAppError(err: unknown, ref: string): AppError {
  if (isAppError(err)) return err;
  return new AppError(
    'INTERNAL_ERROR',
    { ref },
    { publicMessage: `Internal error (ref ${ref}).`, message: privateMessage(err), cause: err },
  );
}

function privateMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'non-error thrown';
}

/** `details` as a plain record for the structured projection; `roots` of `PATH_NOT_ALLOWED` stay private over http. */
function publicDetails(error: AppError, transport: 'http' | 'stdio'): Record<string, unknown> {
  const details: unknown = error.details;
  if (typeof details !== 'object' || details === null) return {};
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(details));
  if (error.code === 'PATH_NOT_ALLOWED' && transport === 'http') delete record['roots'];
  return record;
}

/** `_meta` key carrying `McpErrorContent` on error results. */
export const ERROR_META_KEY = 'browserhive.ai/error';

/**
 * The error projection: one `[CODE] message` text block (the stable text format agents parse) plus
 * `McpErrorContent` under `_meta['browserhive.ai/error']`.
 *
 * Not `structuredContent`: the pinned SDK client validates *any* present `structuredContent`
 * against the tool's `outputSchema`, error results included, and throws — an SDK-based agent would
 * get a protocol exception instead of the `[CODE] message` text (D-07, D-12).
 */
export function shapeError(error: AppError, transport: 'http' | 'stdio'): ShapedResult {
  const message = publicMessageOf(error);
  const details = publicDetails(error, transport);
  const structured: McpErrorContent = {
    code: error.code,
    message,
    retryable: error.retryable,
    ...(error.hint !== undefined && { hint: error.hint }),
    ...(Object.keys(details).length > 0 && { details }),
  };
  return {
    content: [{ type: 'text', text: `[${error.code}] ${message}` }],
    _meta: { [ERROR_META_KEY]: { ...structured } },
    isError: true,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Success projection. `json`: one text block `JSON.stringify(value ?? null)` plus
 * `structuredContent` for object outputs only (bare-array outputs are text-only; the SDK never
 * advertises an array `outputSchema`). Structured content is parsed through the output schema so
 * additive wire keys (`driver`) never violate `additionalProperties: false`.
 */
export function shapeSuccess(result: ToolResult<unknown>, output: z.ZodType): ShapedResult {
  if (result.kind === 'content') {
    return {
      content: [...result.content],
      ...(isPlainObject(result.structured) && { structuredContent: result.structured }),
    };
  }
  const text = JSON.stringify(result.value ?? null);
  if (!isPlainObject(result.value)) return { content: [{ type: 'text', text }] };
  const parsed = output.safeParse(result.value);
  const structured = parsed.success && isPlainObject(parsed.data) ? parsed.data : result.value;
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function scrubValue(value: unknown, scrub: (text: string) => string, depth: number): unknown {
  if (typeof value === 'string') return scrub(value);
  if (depth > 32 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, scrub, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, scrubValue(v, scrub, depth + 1)]),
  );
}

/** Applies `scrub` to every text block and every string inside `structuredContent`; image blocks are not scrubbed (documented). */
export function redactShaped(shaped: ShapedResult, scrub: (text: string) => string): ShapedResult {
  const content = shaped.content.map(
    (block): ContentBlock =>
      block.type === 'text' ? { type: 'text', text: scrub(block.text) } : block,
  );
  const structured = shaped.structuredContent;
  const scrubbed = structured === undefined ? undefined : scrubValue(structured, scrub, 0);
  const meta = shaped._meta === undefined ? undefined : scrubValue(shaped._meta, scrub, 0);
  return {
    content,
    ...(isPlainObject(scrubbed) && { structuredContent: scrubbed }),
    ...(isPlainObject(meta) && { _meta: meta }),
    ...(shaped.isError === true && { isError: true as const }),
  };
}

/** The first text block (what the observation records as `resultText`), or `null`. */
export function firstText(shaped: ShapedResult): string | null {
  for (const block of shaped.content) if (block.type === 'text') return block.text;
  return null;
}

/** Serialized byte size of what the client receives. */
export function shapedSize(shaped: ShapedResult): number {
  return new TextEncoder().encode(JSON.stringify(shaped.content)).byteLength;
}
