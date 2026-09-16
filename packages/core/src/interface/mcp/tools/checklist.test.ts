/** @module interface/mcp/tools/checklist.test — fails when any of the 43 tools lacks a successful execution test (`executeTool(h, '<name>'` in a tools/*.test.ts file). */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_TOOL_NAMES } from '@browserhive/contracts/tools';

describe('tool execution checklist (spec 09 §3.2)', () => {
  it('every tool is executed at least once against the fakes', () => {
    const dir = import.meta.dir;
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts') && f !== 'checklist.test.ts')
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    const executed = new Set(
      [...sources.matchAll(/executeTool\(\s*h,\s*'([a-z_]+)'/g)].map((m) => m[1]),
    );
    const missing = ALL_TOOL_NAMES.filter((name) => !executed.has(name));
    expect(missing).toEqual([]);
    expect(ALL_TOOL_NAMES).toHaveLength(43);
  });
});
