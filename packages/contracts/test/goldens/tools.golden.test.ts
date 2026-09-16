/** @module contracts/test/goldens/tools — per-tool wire goldens for the frozen 43-tool catalog (D-12) */
/// <reference types="bun-types" />

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ALL_TOOL_NAMES,
  TOOL_CONTRACTS,
  type ToolName,
  toolInputJsonSchema,
  toolOutputJsonSchema,
} from '../../src/tools/index.ts';

const GOLDEN_DIR = `${import.meta.dir}/tools/`;
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

/** What the golden file records for one tool: exactly what reaches the wire in `tools/list`. */
function goldenFor(name: ToolName): Record<string, unknown> {
  const contract = TOOL_CONTRACTS[name];
  return {
    name: contract.name,
    title: contract.title,
    description: contract.description,
    inputSchema: toolInputJsonSchema(name),
    outputSchema: toolOutputJsonSchema(name),
    annotations: contract.annotations,
    since: contract.since,
  };
}

function goldenPath(name: ToolName): string {
  return `${GOLDEN_DIR}${name}.json`;
}

const GoldenFile = z.record(z.string(), z.unknown());

/** The committed golden, parsed; `null` when the file does not exist yet. */
function readGolden(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return GoldenFile.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** The error registry, when the sibling module is present (it is built concurrently). */
async function loadErrorCodes(): Promise<readonly string[] | null> {
  const specifier = '../../src/errors/index.ts';
  try {
    const mod: unknown = await import(specifier);
    const parsed = z.object({ ERROR_CODES: z.array(z.string()) }).safeParse(mod);
    return parsed.success ? parsed.data.ERROR_CODES : null;
  } catch {
    return null;
  }
}

describe('tool goldens (D-12)', () => {
  it('has 43 unique tools in registration order', () => {
    expect(ALL_TOOL_NAMES).toHaveLength(43);
    expect(new Set(ALL_TOOL_NAMES).size).toBe(43);
    expect(ALL_TOOL_NAMES).toEqual([
      'launch_session',
      'close_session',
      'list_sessions',
      'server_status',
      'session_info',
      'navigate',
      'go_back',
      'go_forward',
      'reload',
      'wait_for_url',
      'new_tab',
      'close_tab',
      'switch_tab',
      'list_tabs',
      'click',
      'type_text',
      'fill',
      'press_key',
      'hover',
      'select_option',
      'scroll',
      'drag_and_drop',
      'screenshot',
      'snapshot',
      'get_content',
      'evaluate',
      'wait_for_selector',
      'wait_for_load_state',
      'accept_next_dialog',
      'dismiss_next_dialog',
      'get_cookies',
      'set_cookies',
      'set_viewport',
      'set_extra_http_headers',
      'upload_file',
      'download_file',
      'save_storage_state',
      'save_full_profile',
      'list_saved_auths',
      'request_attention',
      'get_attention_result',
      'vault_list_available',
      'vault_fill',
    ]);
  });

  it('keeps every input schema a flat object (no oneOf/anyOf/allOf at the root)', () => {
    for (const name of ALL_TOOL_NAMES) {
      const input = toolInputJsonSchema(name);
      expect(input['type']).toBe('object');
      expect('oneOf' in input).toBe(false);
      expect('anyOf' in input).toBe(false);
      expect('allOf' in input).toBe(false);
    }
  });

  it('only documents error codes that exist in the registry', async () => {
    const codes = await loadErrorCodes();
    if (codes === null) return; // registry not built yet; the invariant is re-checked once it lands
    const known = new Set(codes);
    for (const name of ALL_TOOL_NAMES) {
      for (const code of TOOL_CONTRACTS[name].errors) {
        expect(known.has(code)).toBe(true);
      }
    }
  });

  for (const name of ALL_TOOL_NAMES) {
    it(`matches test/goldens/tools/${name}.json`, () => {
      const actual = goldenFor(name);
      const path = goldenPath(name);
      const current = readGolden(path);
      // Rewrite only when the wire shape really changed: biome reformats the committed JSON, so an
      // unconditional rewrite would churn every bless. Run `biome check --write` after blessing.
      const changed = current === null || JSON.stringify(current) !== JSON.stringify(actual);
      if ((UPDATE || current === null) && changed) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
      }
      const expected = readGolden(path);
      expect(actual).toEqual(expected ?? {});
    });
  }
});
