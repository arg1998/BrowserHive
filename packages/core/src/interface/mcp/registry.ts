/** @module interface/mcp/registry — the single ordered tool list (13 packs, spec 02 §3.14): resolved schemas and descriptions per runtime, pack availability. */

import { ALL_TOOL_NAMES, type ToolName, type ToolPackId } from '@browserhive/contracts/tools';
import type { z } from 'zod';
import type { RuntimeFacts } from './context.ts';
import type { AnyToolDefinition, ToolPack } from './definition.ts';
import { attentionPack } from './tools/attention/index.ts';
import { authStatesPack } from './tools/auth-states/index.ts';
import { dialogsPack } from './tools/dialogs/index.ts';
import { filesPack } from './tools/files/index.ts';
import { inspectionPack } from './tools/inspection/index.ts';
import { interactionPack } from './tools/interaction/index.ts';
import { introspectionPack } from './tools/introspection/index.ts';
import { lifecyclePack } from './tools/lifecycle/index.ts';
import { navigationPack } from './tools/navigation/index.ts';
import { statePack } from './tools/state/index.ts';
import { tabsPack } from './tools/tabs/index.ts';
import { vaultPack } from './tools/vault/index.ts';
import { waitsPack } from './tools/waits/index.ts';

/** Every pack in registration order. */
export const TOOL_PACK_LIST: readonly ToolPack[] = [
  lifecyclePack,
  introspectionPack,
  navigationPack,
  tabsPack,
  interactionPack,
  inspectionPack,
  waitsPack,
  dialogsPack,
  statePack,
  filesPack,
  authStatesPack,
  attentionPack,
  vaultPack,
];

/** Every definition in registration order (the only hand-maintained list; pinned against `ALL_TOOL_NAMES`). */
export const TOOL_DEFINITIONS: readonly AnyToolDefinition[] = TOOL_PACK_LIST.flatMap(
  (p) => p.tools,
);

/** Options of {@link createToolRegistry}. */
export interface ToolRegistryOptions {
  /** Packs disabled by configuration: their tools stay listed but answer `TOOL_NOT_AVAILABLE`. */
  readonly disabledPacks?: readonly ToolPackId[];
}

/** The registry a server and dispatcher share. */
export interface ToolRegistry {
  readonly definitions: readonly AnyToolDefinition[];
  get(name: string): AnyToolDefinition | undefined;
  /** The input schema with runtime defaults baked in, or `undefined` for input-less tools. */
  inputOf(name: string): z.ZodType | undefined;
  /** The description rendered for this runtime. */
  descriptionOf(name: string): string;
  isAvailable(name: string): boolean;
  /** Human text of what a tool requires (`TOOL_NOT_AVAILABLE.details.requires`). */
  requirementOf(name: string): string;
}

/** Builds the registry for one runtime (schemas and descriptions resolved once). */
export function createToolRegistry(
  runtime: RuntimeFacts,
  options: ToolRegistryOptions = {},
): ToolRegistry {
  const disabled = new Set(options.disabledPacks ?? []);
  const byName = new Map<string, AnyToolDefinition>();
  const inputs = new Map<string, z.ZodType>();
  const descriptions = new Map<string, string>();
  const packRequires = new Map<string, string>();
  for (const pack of TOOL_PACK_LIST) {
    for (const def of pack.tools) {
      byName.set(def.name, def);
      const input = typeof def.input === 'function' ? def.input(runtime) : def.input;
      if (input !== undefined) inputs.set(def.name, input);
      descriptions.set(
        def.name,
        typeof def.description === 'function' ? def.description(runtime) : def.description,
      );
      const req = def.requires ?? pack.requires;
      const parts = [
        `pack ${pack.id}`,
        ...(req?.transport !== undefined ? [`transport=${req.transport}`] : []),
        ...(req?.vault === true ? ['vault'] : []),
      ];
      packRequires.set(def.name, parts.join(', '));
    }
  }
  return {
    definitions: TOOL_DEFINITIONS,
    get: (name) => byName.get(name),
    inputOf: (name) => inputs.get(name),
    descriptionOf: (name) => descriptions.get(name) ?? '',
    isAvailable: (name) => {
      const def = byName.get(name);
      return def !== undefined && !disabled.has(def.pack);
    },
    requirementOf: (name) => packRequires.get(name) ?? 'unknown tool',
  };
}

/** Names in registration order; equal to `ALL_TOOL_NAMES` (asserted by the wiring test). */
export const REGISTERED_TOOL_NAMES: readonly ToolName[] = TOOL_DEFINITIONS.map((d) => d.name);

/** Re-export so wiring tests and composition need one import. */
export { ALL_TOOL_NAMES };
