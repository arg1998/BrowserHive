/** @module contracts/tools/types — ToolContract shape, MCP annotations, capabilities and pack ids */
import { z } from 'zod';
import { ToolCapability } from '../enums/tool-capability.ts';
import type { ErrorCode } from '../errors/index.ts';

/** Tool packs, in registration order (spec 02 §2.1). */
export const ToolPackId = z.enum([
  'lifecycle',
  'introspection',
  'navigation',
  'tabs',
  'interaction',
  'inspection',
  'waits',
  'dialogs',
  'state',
  'files',
  'authStates',
  'attention',
  'vault',
]);
/** Union of {@link ToolPackId} values. */
export type ToolPackId = z.infer<typeof ToolPackId>;

export { ToolCapability };

/** MCP `ToolAnnotations` hints (all four are always set explicitly; none is inferred). */
export interface ToolAnnotations {
  /** The tool does not modify its environment. */
  readonly readOnlyHint: boolean;
  /** The tool may perform destructive updates (only meaningful when not read-only). */
  readonly destructiveHint: boolean;
  /** Calling the tool repeatedly with the same arguments has no additional effect. */
  readonly idempotentHint: boolean;
  /** The tool interacts with an open world of external entities (the public web). */
  readonly openWorldHint: boolean;
}

/**
 * The only admissible root for a tool input: a flat `z.object` / `z.looseObject`. Never a union —
 * strict MCP clients reject an `inputSchema` whose root is `oneOf` / `anyOf` / `allOf`.
 */
export type ToolInputSchema = z.ZodObject<z.core.$ZodShape, z.core.$ZodObjectConfig>;

/**
 * One frozen tool contract (D-12): everything the MCP `tools/list` entry, the dispatcher and the
 * docs generator need, minus the handler (which lives in core).
 *
 * @typeParam N - the literal tool name
 * @typeParam I - the input schema, or `undefined` for the three argument-free tools without `inputSchema`
 * @typeParam O - the output (result) schema; becomes `outputSchema` + `structuredContent`
 */
export interface ToolContract<
  N extends string = string,
  I extends ToolInputSchema | undefined = ToolInputSchema | undefined,
  O extends z.ZodType = z.ZodType,
> {
  /** Frozen wire name (snake_case). */
  readonly name: N;
  /** Human title (additive MCP annotation). */
  readonly title: string;
  /** Agent-facing description; part of the frozen contract (agents rely on its wording). */
  readonly description: string;
  /**
   * Flat object input schema. Omitted ⇒ the tool takes no arguments: the SDK advertises an empty
   * object schema and any `arguments` a client sends are ignored rather than rejected.
   */
  readonly input?: I;
  /** Result schema. Optional keys are omitted (never `null`) when absent. */
  readonly output: O;
  /** MCP tool annotations. */
  readonly annotations: ToolAnnotations;
  /** Owning pack. */
  readonly pack: ToolPackId;
  /** Policy class. */
  readonly capability: ToolCapability;
  /** Documented error codes; the dispatcher may add `INTERNAL_ERROR` and `INVALID_ARGUMENTS`. */
  readonly errors: readonly ErrorCode[];
  /** Semver of first appearance (`'0.1.0'` for the 43 tools of the first release). */
  readonly since: string;
}

/**
 * Identity helper that pins the generic parameters of a {@link ToolContract} from its literal so
 * `TOOL_CONTRACTS[name].input` / `.output` stay precisely typed. When `input` is supplied the
 * returned type marks it required; when omitted, `I` is `undefined`.
 */
export function defineTool<const N extends string, I extends ToolInputSchema, O extends z.ZodType>(
  contract: ToolContract<N, I, O> & { readonly input: I },
): ToolContract<N, I, O> & { readonly input: I };
export function defineTool<const N extends string, O extends z.ZodType>(
  contract: Omit<ToolContract<N, undefined, O>, 'input'>,
): ToolContract<N, undefined, O>;
export function defineTool<
  const N extends string,
  I extends ToolInputSchema | undefined,
  O extends z.ZodType,
>(contract: ToolContract<N, I, O>): ToolContract<N, I, O> {
  return contract;
}
