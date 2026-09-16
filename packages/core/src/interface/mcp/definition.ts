/** @module interface/mcp/definition — ToolDefinition (spec 02 §2.1), ToolResult, ToolPack and the `defineTool` helper that types a handler from its frozen contract. */

import type { ErrorCode } from '@browserhive/contracts/errors';
import {
  type ToolResult as ContractResult,
  TOOL_CONTRACTS,
  type ToolAnnotations,
  type ToolArgs,
  type ToolCapability,
  type ToolName,
  type ToolPackId,
} from '@browserhive/contracts/tools';
import type { z } from 'zod';
import type { Session } from '../../domain/session/session.ts';
import type { RuntimeFacts, ToolCallContext } from './context.ts';

/** An MCP content block a tool may return (`screenshot` is the only content tool). */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** A screenshot the tool already archived; the dispatcher publishes `screenshot.captured` after `tool.called`. */
export interface ScreenshotArtifact {
  readonly path: string;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  /** Page URL at capture time (the `screenshots` row carries it). */
  readonly url: string;
}

/**
 * What a handler returns. `json` is serialized as one `text` block (`JSON.stringify(value ?? null)`)
 * plus `structuredContent` for object outputs; `content` passes the blocks through verbatim.
 */
export type ToolResult<V> =
  | { readonly kind: 'json'; readonly value: V; readonly facts?: ToolFacts }
  | {
      readonly kind: 'content';
      readonly content: readonly ContentBlock[];
      readonly structured?: V;
      readonly facts?: ToolFacts;
    };

/** A page the call navigated to; the dispatcher publishes `page.visited` after `tool.called`. */
export interface PageVisit {
  readonly sessionId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string | null;
}

/**
 * Facts a handler produced that become rows keyed on the call's event id. They are published by the
 * dispatcher **after** `tool.called`, because `screenshots.event_id` references `tool_calls`.
 */
export interface ToolFacts {
  readonly pageVisit?: PageVisit;
  readonly screenshot?: ScreenshotArtifact & { readonly sessionId: string };
}

/** Context a policy sees: the call context plus the one mutation policies are allowed to make. */
export interface PolicyContext extends ToolCallContext {
  /** Records the session the ownership check resolved (read by every later step and the handler). */
  attachSession(session: Session): void;
}

/** A pre-execution check (ownership, blocklist, evaluate gate, sandbox, transport, vault). */
export interface ToolPolicy {
  readonly name: string;
  /** Throws an `AppError` to refuse the call before the browser is touched. */
  apply(ctx: PolicyContext, args: Readonly<Record<string, unknown>>): Promise<void> | void;
}

/** Feature requirements; unmet ⇒ `TOOL_NOT_AVAILABLE` when the pack is disabled (spec 02 §2.4). */
export interface ToolRequirements {
  readonly transport?: 'http';
  readonly vault?: true;
}

/** How much of a call the observation records (D-20). */
export interface ToolTelemetry {
  readonly captureArgs: 'full' | 'shape' | 'none';
  readonly captureResult: 'full' | 'size' | 'none';
}

/** Default telemetry: everything (results are capped and redacted downstream). */
export const DEFAULT_TELEMETRY: ToolTelemetry = { captureArgs: 'full', captureResult: 'full' };

/** The typed handler of tool `N`. */
export type ToolHandler<N extends ToolName> = (
  ctx: ToolCallContext,
  args: ToolArgs<N>,
) => Promise<ToolResult<ContractResult<N>>>;

/** One tool: its frozen contract plus policies, telemetry and the handler (spec 02 §2.1). */
export interface ToolDefinition<N extends ToolName = ToolName> {
  readonly name: N;
  readonly title: string;
  /** `request_attention` renders the operator floor into its description. */
  readonly description: string | ((runtime: RuntimeFacts) => string);
  /** Omitted ⇒ no `inputSchema`; a function bakes server defaults in (`launch_session`). */
  readonly input?: z.ZodType | ((runtime: RuntimeFacts) => z.ZodType);
  readonly output: z.ZodType;
  readonly annotations: ToolAnnotations;
  readonly pack: ToolPackId;
  readonly capability: ToolCapability;
  readonly requires?: ToolRequirements;
  readonly policies: readonly ToolPolicy[];
  readonly telemetry: ToolTelemetry;
  readonly errors: readonly ErrorCode[];
  readonly since: string;
  /** Method syntax on purpose: definitions of different tools share one registry array. */
  handler(ctx: ToolCallContext, args: ToolArgs<N>): Promise<ToolResult<ContractResult<N>>>;
}

/** Any one tool's definition (the union keeps each handler paired with its own contract). */
export type AnyToolDefinition = { [N in ToolName]: ToolDefinition<N> }[ToolName];

/** A pack: the registration unit (spec 02 §2.1). */
export interface ToolPack {
  readonly id: ToolPackId;
  readonly tools: readonly AnyToolDefinition[];
  readonly requires?: ToolRequirements;
}

/** What `defineTool` needs beyond the contract. */
export interface ToolSpec<N extends ToolName> {
  readonly description?: (runtime: RuntimeFacts) => string;
  readonly input?: (runtime: RuntimeFacts) => z.ZodType;
  readonly requires?: ToolRequirements;
  readonly policies: readonly ToolPolicy[];
  readonly telemetry?: Partial<ToolTelemetry>;
  readonly handler: ToolHandler<N>;
}

/**
 * Builds a {@link ToolDefinition} from the frozen contract of `name` (title, description, schemas,
 * annotations, pack, capability, errors, since are never redefined) plus the runtime spec.
 */
export function defineTool<N extends ToolName>(name: N, spec: ToolSpec<N>): ToolDefinition<N> {
  const key: ToolName = name;
  const contract = TOOL_CONTRACTS[key];
  const frozenInput: z.ZodType | undefined = 'input' in contract ? contract.input : undefined;
  const input = spec.input ?? frozenInput;
  return {
    name,
    title: contract.title,
    description: spec.description ?? contract.description,
    ...(input !== undefined && { input }),
    output: contract.output,
    annotations: contract.annotations,
    pack: contract.pack,
    capability: contract.capability,
    ...(spec.requires !== undefined && { requires: spec.requires }),
    policies: spec.policies,
    telemetry: { ...DEFAULT_TELEMETRY, ...spec.telemetry },
    errors: contract.errors,
    since: contract.since,
    handler: spec.handler,
  };
}

/** Shorthand for the common `{ kind: 'json', value }` result. */
export function json<V>(value: V, facts?: ToolFacts): ToolResult<V> {
  return { kind: 'json', value, ...(facts !== undefined && { facts }) };
}
