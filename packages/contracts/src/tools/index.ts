/** @module contracts/tools — the frozen 43-tool catalog: contracts, names, packs and JSON Schema helpers */
import { z } from 'zod';
import { GET_ATTENTION_RESULT, REQUEST_ATTENTION } from './attention.ts';
import { LIST_SAVED_AUTHS, SAVE_FULL_PROFILE, SAVE_STORAGE_STATE } from './auth-states.ts';
import { ACCEPT_NEXT_DIALOG, DISMISS_NEXT_DIALOG } from './dialogs.ts';
import { DOWNLOAD_FILE, UPLOAD_FILE } from './files.ts';
import { EVALUATE, GET_CONTENT, SCREENSHOT, SNAPSHOT } from './inspection.ts';
import {
  CLICK,
  DRAG_AND_DROP,
  FILL,
  HOVER,
  PRESS_KEY,
  SCROLL,
  SELECT_OPTION,
  TYPE_TEXT,
} from './interaction.ts';
import { SERVER_STATUS, SESSION_INFO } from './introspection.ts';
import { CLOSE_SESSION, LAUNCH_SESSION, LIST_SESSIONS } from './lifecycle.ts';
import { GO_BACK, GO_FORWARD, NAVIGATE, RELOAD, WAIT_FOR_URL } from './navigation.ts';
import { GET_COOKIES, SET_COOKIES, SET_EXTRA_HTTP_HEADERS, SET_VIEWPORT } from './state.ts';
import { CLOSE_TAB, LIST_TABS, NEW_TAB, SWITCH_TAB } from './tabs.ts';
import type { ToolContract, ToolPackId } from './types.ts';
import { VAULT_FILL, VAULT_LIST_AVAILABLE } from './vault.ts';
import { WAIT_FOR_LOAD_STATE, WAIT_FOR_SELECTOR } from './waits.ts';

/**
 * Every contract in registration order (spec 02 §3.14). This tuple is the single
 * source: `ALL_TOOL_NAMES`, `TOOL_CONTRACTS` and `TOOL_PACKS` are all derived from it.
 */
const ORDERED_CONTRACTS = [
  LAUNCH_SESSION,
  CLOSE_SESSION,
  LIST_SESSIONS,
  SERVER_STATUS,
  SESSION_INFO,
  NAVIGATE,
  GO_BACK,
  GO_FORWARD,
  RELOAD,
  WAIT_FOR_URL,
  NEW_TAB,
  CLOSE_TAB,
  SWITCH_TAB,
  LIST_TABS,
  CLICK,
  TYPE_TEXT,
  FILL,
  PRESS_KEY,
  HOVER,
  SELECT_OPTION,
  SCROLL,
  DRAG_AND_DROP,
  SCREENSHOT,
  SNAPSHOT,
  GET_CONTENT,
  EVALUATE,
  WAIT_FOR_SELECTOR,
  WAIT_FOR_LOAD_STATE,
  ACCEPT_NEXT_DIALOG,
  DISMISS_NEXT_DIALOG,
  GET_COOKIES,
  SET_COOKIES,
  SET_VIEWPORT,
  SET_EXTRA_HTTP_HEADERS,
  UPLOAD_FILE,
  DOWNLOAD_FILE,
  SAVE_STORAGE_STATE,
  SAVE_FULL_PROFILE,
  LIST_SAVED_AUTHS,
  REQUEST_ATTENTION,
  GET_ATTENTION_RESULT,
  VAULT_LIST_AVAILABLE,
  VAULT_FILL,
] as const;

type AnyContract = (typeof ORDERED_CONTRACTS)[number];

/** Union of the 43 frozen tool names. */
export type ToolName = AnyContract['name'];

/** The contract for tool `N`, with its precise input/output schema types. */
export type ToolContractOf<N extends ToolName> = Extract<AnyContract, { name: N }>;

/** Parsed (post-default) arguments of tool `N`; `undefined` for the three input-less tools. */
export type ToolArgs<N extends ToolName> =
  ToolContractOf<N> extends { input: infer I }
    ? I extends z.ZodType
      ? z.output<I>
      : undefined
    : undefined;

/** Result value of tool `N` (what becomes the JSON text block and `structuredContent`). */
export type ToolResult<N extends ToolName> = z.output<ToolContractOf<N>['output']>;

type ContractRecord = { readonly [N in ToolName]: ToolContractOf<N> };

function indexByName(list: readonly AnyContract[]): ContractRecord {
  const record: Partial<Record<ToolName, AnyContract>> = {};
  for (const contract of list) record[contract.name] = contract;
  // The loop covers every member of the tuple, so the partial record is complete; the widening
  // from `AnyContract` back to the per-name member is a type-level refinement of a static list,
  // not a payload cast.
  return record as ContractRecord;
}

/** Contracts keyed by name. */
export const TOOL_CONTRACTS: ContractRecord = indexByName(ORDERED_CONTRACTS);

/** The 43 names in registration order (pinned by the golden and the stdio handshake test). */
export const ALL_TOOL_NAMES: readonly ToolName[] = ORDERED_CONTRACTS.map((c) => c.name);

/** Zod schema of a tool name (for parsing wire input). */
export const ToolNameSchema = z.enum(ALL_TOOL_NAMES as [ToolName, ...ToolName[]]);

/** Whether `value` names one of the 43 tools. */
export function isToolName(value: string): value is ToolName {
  return Object.hasOwn(TOOL_CONTRACTS, value);
}

function groupByPack(list: readonly AnyContract[]): {
  readonly [P in ToolPackId]: readonly ToolName[];
} {
  const groups: Record<ToolPackId, ToolName[]> = {
    lifecycle: [],
    introspection: [],
    navigation: [],
    tabs: [],
    interaction: [],
    inspection: [],
    waits: [],
    dialogs: [],
    state: [],
    files: [],
    authStates: [],
    attention: [],
    vault: [],
  };
  for (const contract of list) groups[contract.pack].push(contract.name);
  return groups;
}

/** Tool names per pack, each in registration order. */
export const TOOL_PACKS: { readonly [P in ToolPackId]: readonly ToolName[] } =
  groupByPack(ORDERED_CONTRACTS);

/** JSON Schema document as emitted on the MCP wire. */
export type ToolJsonSchema = z.core.JSONSchema.BaseSchema;

/**
 * The `inputSchema` the SDK advertises for a tool without an input schema
 * (`EMPTY_OBJECT_JSON_SCHEMA` in `@modelcontextprotocol/sdk`).
 */
export const EMPTY_INPUT_JSON_SCHEMA: ToolJsonSchema = { type: 'object', properties: {} };

/**
 * JSON Schema (draft-07, `io: 'input'`) of a tool's input, byte-compatible with what the MCP SDK's
 * zod-4 path (`toJSONSchema(schema, { target: 'draft-7', io: 'input' })`) sends in `tools/list`.
 */
export function toolInputJsonSchema(name: ToolName): ToolJsonSchema {
  const contract: ToolContract = TOOL_CONTRACTS[name];
  if (contract.input === undefined) return EMPTY_INPUT_JSON_SCHEMA;
  return z.toJSONSchema(contract.input, { target: 'draft-07', io: 'input' });
}

/** JSON Schema (draft-07, `io: 'output'`) of a tool's result, as the SDK sends `outputSchema`. */
export function toolOutputJsonSchema(name: ToolName): ToolJsonSchema {
  const contract: ToolContract = TOOL_CONTRACTS[name];
  return z.toJSONSchema(contract.output, { target: 'draft-07', io: 'output' });
}

export {
  AttentionOutcome,
  requestAttentionDescription,
  requestAttentionFloorNote,
} from './attention.ts';
export { AUTH_NAME_RE, SavedAuthEntry, SavedAuthResult } from './auth-states.ts';
export {
  BASE_LAUNCH_DEFAULTS,
  BrowserContextOptions,
  LaunchOptions,
  type LaunchSessionDefaults,
  launchSessionInput,
  SLUG_RE,
} from './lifecycle.ts';
export { AppliedIdentity, SessionMetadata } from './session-metadata.ts';
export { SESSION_ERRORS, Selector, TabId, Timeout, WaitUntil } from './shared.ts';
export { Cookie, CookieInput } from './state.ts';
export { TabSummary } from './tabs.ts';
export {
  defineTool,
  type ToolAnnotations,
  ToolCapability,
  type ToolContract,
  type ToolInputSchema,
  ToolPackId,
} from './types.ts';
export {
  AvailableVaultEntry,
  VaultFillResult,
  VaultFillStatus,
  VaultListResult,
  VaultListScope,
} from './vault.ts';
