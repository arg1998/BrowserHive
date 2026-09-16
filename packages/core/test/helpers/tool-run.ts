/** @module test/helpers/tool-run — `executeTool`: one successful tool execution through the harness, asserted against the contract output schema (the checklist test scans for its call sites). */

import { expect } from 'bun:test';
import { TOOL_CONTRACTS, type ToolName } from '@browserhive/contracts/tools';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type ToolHarness, textOf } from './fake-transport.ts';

/** What a successful execution yields. */
export interface Executed {
  readonly result: CallToolResult;
  /** Parsed JSON text (content tools: the structured content). */
  readonly value: unknown;
}

/**
 * Calls `name` with `args` (defaults applied by the real zod schema inside the dispatcher), expects
 * success, and parses the result with `TOOL_CONTRACTS[name].output`.
 */
export async function executeTool(
  h: ToolHarness,
  name: ToolName,
  args: Record<string, unknown> = {},
  client?: Client,
): Promise<Executed> {
  const result = await h.call(name, args, client);
  if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
  const image = result.content.some((c) => c.type === 'image');
  const value: unknown = image ? result.structuredContent : JSON.parse(textOf(result));
  const parsed = TOOL_CONTRACTS[name].output.safeParse(
    name === 'evaluate' && result.structuredContent !== undefined
      ? result.structuredContent
      : value,
  );
  expect(parsed.success).toBe(true);
  return { result, value };
}
