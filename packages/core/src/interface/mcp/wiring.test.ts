/** @module interface/mcp/wiring.test — `tools/list` equals the frozen catalog: names in registration order, and each wire entry equals the contracts golden; launch defaults come from config. */

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_TOOL_NAMES } from '@browserhive/contracts/tools';
import { createToolHarness, type ToolHarness } from '../../../test/helpers/fake-transport.ts';
import { REGISTERED_TOOL_NAMES, TOOL_PACK_LIST } from './registry.ts';

const GOLDEN_DIR = join(import.meta.dir, '../../../../contracts/test/goldens/tools');

let h: ToolHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('tool wiring', () => {
  it('the registry is exactly ALL_TOOL_NAMES in registration order, in 13 packs', () => {
    expect(REGISTERED_TOOL_NAMES).toEqual(ALL_TOOL_NAMES);
    expect(TOOL_PACK_LIST.map((p) => p.id)).toEqual([
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
    for (const pack of TOOL_PACK_LIST)
      for (const tool of pack.tools) expect(tool.pack).toBe(pack.id);
  });

  it('tools/list matches the contracts goldens (default launch settings, attention floor 0)', async () => {
    const harness = await createToolHarness();
    h = harness;
    const { tools } = await harness.client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...ALL_TOOL_NAMES]);
    for (const tool of tools) {
      const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, `${tool.name}.json`), 'utf8'));
      expect({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }).toEqual({
        name: golden.name,
        description: golden.description,
        inputSchema: golden.inputSchema,
      });
      expect(tool.title).toBe(golden.title);
      expect(tool.annotations).toEqual({ title: golden.title, ...golden.annotations });
      if (golden.outputSchema.type === 'object')
        expect(tool.outputSchema).toEqual(golden.outputSchema);
      else expect(tool.outputSchema).toBeUndefined();
    }
  });

  it('launch_session advertises defaultChannel/defaultHeadless from config', async () => {
    const harness = await createToolHarness({ defaultChannel: 'edge', defaultHeadless: false });
    h = harness;
    const { tools } = await harness.client.listTools();
    const props = tools.find((t) => t.name === 'launch_session')?.inputSchema.properties ?? {};
    expect(props['channel']).toMatchObject({ default: 'edge' });
    expect(props['headless']).toMatchObject({ default: false });
  });

  it('advertises logging and listChanged tools capabilities and instructions', async () => {
    const harness = await createToolHarness({ minAttentionWaitMs: 60_000 });
    h = harness;
    expect(harness.client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: true },
      logging: {},
    });
    expect(harness.client.getServerVersion()).toEqual({ name: 'browserhive', version: '0.1.0' });
    expect(harness.client.getInstructions()).toContain('minimum attention wait of 60s');
  });
});
