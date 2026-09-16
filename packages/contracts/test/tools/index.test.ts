/** @module contracts/test/tools/index.test — catalog invariants and JSON Schema helpers */
/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import {
  ALL_TOOL_NAMES,
  EMPTY_INPUT_JSON_SCHEMA,
  isToolName,
  TOOL_CONTRACTS,
  TOOL_PACKS,
  ToolNameSchema,
  toolInputJsonSchema,
  toolOutputJsonSchema,
} from '../../src/tools/index.ts';
import { ToolPackId } from '../../src/tools/types.ts';

describe('tool catalog', () => {
  it('has 43 unique names in registration order', () => {
    expect(ALL_TOOL_NAMES).toHaveLength(43);
    expect(new Set(ALL_TOOL_NAMES).size).toBe(43);
    expect(ALL_TOOL_NAMES[0]).toBe('launch_session');
    expect(ALL_TOOL_NAMES[42]).toBe('vault_fill');
    expect(Object.keys(TOOL_CONTRACTS)).toEqual([...ALL_TOOL_NAMES]);
    for (const name of ALL_TOOL_NAMES) expect(TOOL_CONTRACTS[name].name).toBe(name);
  });

  it('groups every tool into exactly one pack, packs in registration order', () => {
    expect(Object.keys(TOOL_PACKS)).toEqual([...ToolPackId.options]);
    expect(Object.values(TOOL_PACKS).flat()).toEqual([...ALL_TOOL_NAMES]);
    expect(TOOL_PACKS.lifecycle).toEqual(['launch_session', 'close_session', 'list_sessions']);
    expect(TOOL_PACKS.vault).toEqual(['vault_list_available', 'vault_fill']);
  });

  it('exposes name guards', () => {
    expect(isToolName('click')).toBe(true);
    expect(isToolName('toString')).toBe(false);
    expect(ToolNameSchema.safeParse('nope').success).toBe(false);
  });

  it('marks navigation-count tools with the navigate capability', () => {
    const navigate = ALL_TOOL_NAMES.filter((n) => TOOL_CONTRACTS[n].capability === 'navigate');
    expect(navigate).toEqual(['navigate', 'go_back', 'go_forward', 'reload', 'new_tab']);
  });
});

describe('json schema helpers', () => {
  it('mirrors the SDK for input-less tools', () => {
    for (const name of ['list_sessions', 'server_status', 'list_saved_auths'] as const) {
      expect('input' in TOOL_CONTRACTS[name]).toBe(false);
      expect(toolInputJsonSchema(name)).toEqual(EMPTY_INPUT_JSON_SCHEMA);
    }
  });

  it('emits draft-07 documents with an object root and no root unions', () => {
    for (const name of ALL_TOOL_NAMES) {
      const input = toolInputJsonSchema(name);
      expect(input['type']).toBe('object');
      for (const key of ['oneOf', 'anyOf', 'allOf', '$ref']) expect(key in input).toBe(false);
      if ('input' in TOOL_CONTRACTS[name]) {
        expect(input['$schema']).toBe('http://json-schema.org/draft-07/schema#');
      }
      expect(toolOutputJsonSchema(name)['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    }
  });

  it('keeps scroll flat and wait_for_url union at property level only', () => {
    const scroll = toolInputJsonSchema('scroll');
    expect(scroll['required']).toEqual(['session_id', 'mode']);
    const waitForUrl = toolInputJsonSchema('wait_for_url');
    const url = waitForUrl['properties']?.['url'];
    expect(typeof url === 'object' && 'anyOf' in url).toBe(true);
  });

  it('serializes the static launch_session defaults', () => {
    const props = toolInputJsonSchema('launch_session')['properties'] ?? {};
    expect(props['channel']).toMatchObject({
      default: 'chromium',
      enum: ['chromium', 'chrome', 'edge'],
    });
    expect(props['headless']).toMatchObject({ default: true });
    expect(props['slug']).toMatchObject({ pattern: '^[a-z][a-z0-9-]{1,31}$' });
  });
});
