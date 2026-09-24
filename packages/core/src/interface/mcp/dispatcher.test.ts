/** @module interface/mcp/dispatcher.test — dispatcher invariants (spec 09 §3.2): one observation per terminal outcome, observer isolation, error projection, redaction, spans. */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { FakeSessionHandle } from '../../../test/helpers/fake-session-handle.ts';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../test/helpers/fake-transport.ts';
import { agentPrincipal } from '../../domain/auth/principal.ts';
import { ERROR_META_KEY } from './shape.ts';

let h: ToolHarness;
afterEach(async () => h.close());

function handle(): FakeSessionHandle {
  const found = h.fakeDriver?.handles[0];
  if (found === undefined) throw new Error('no handle');
  return found;
}

describe('ToolDispatcher invariants', () => {
  it('emits exactly one observation per terminal outcome, including validation, availability and ownership failures', async () => {
    h = await createToolHarness({ disabledPacks: ['vault'] });
    const id = await h.launch();
    const alice = await h.connect(agentPrincipal('alice', {}));
    const before = h.observations().length;
    await h.call('navigate', { session_id: id });
    await h.call('vault_list_available', { session_id: id });
    await h.call('snapshot', { session_id: id }, alice);
    await h.call('snapshot', { session_id: id });
    const obs = h.observations().slice(before);
    expect(obs.map((o) => [o.tool, o.ok, o.errorCode])).toEqual([
      ['navigate', false, 'INVALID_ARGUMENTS'],
      ['vault_list_available', false, 'TOOL_NOT_AVAILABLE'],
      ['snapshot', false, 'SESSION_ACCESS_DENIED'],
      ['snapshot', true, null],
    ]);
    expect(obs[0]?.sessionId).toBeNull();
    expect(obs[2]?.principal).toBe('alice');
    expect(new Set(obs.map((o) => o.eventId)).size).toBe(4);
  });

  it('observation carries the spec 02 §2.3 shape', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    await h.call('get_content', { session_id: id, tab_id: undefined });
    const obs = h.observations().at(-1);
    expect(Object.keys(obs ?? {}).sort()).toEqual(
      [
        'args',
        'connectionId',
        'durationMs',
        'errorCode',
        'errorMessage',
        'eventId',
        'harness',
        'ok',
        'principal',
        'resultSizeBytes',
        'resultText',
        'seq',
        'sessionId',
        'spanId',
        'tabId',
        'tool',
        'traceId',
        'ts',
      ].sort(),
    );
    expect(obs).toMatchObject({
      tool: 'get_content',
      sessionId: id,
      ok: true,
      principal: 'local',
      seq: 2,
      harness: 'unknown',
    });
  });

  it('a throwing observer is logged and never alters the result', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    h.bus.subscribe('tool.called', () => {
      throw new Error('observer exploded');
    });
    const result = await h.call('get_content', { session_id: id });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toMatchObject({ session_id: id });
    expect(h.logger.find('observation failed')).toBeDefined();
  });

  it('the [CODE] message text agrees with the structured error', async () => {
    h = await createToolHarness();
    const result = await h.call('session_info', { session_id: 'ghost-12345678' });
    const meta = result._meta?.[ERROR_META_KEY] as {
      code: string;
      message: string;
      retryable: string;
    };
    expect(textOf(result)).toBe(`[${meta.code}] ${meta.message}`);
    expect(textOf(result)).toBe("[SESSION_NOT_FOUND] No browser session with id 'ghost-12345678'");
    expect(meta.retryable).toBe('different_args');
    expect(result.structuredContent).toBeUndefined();
  });

  it('unknown errors become INTERNAL_ERROR with ref = event id and a private cause', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    handle().firstPage.failWith('content', new Error('/home/secret/path exploded'));
    const result = await h.call('get_content', { session_id: id });
    const obs = h.observations().at(-1);
    expect(textOf(result)).toBe(`[INTERNAL_ERROR] Internal error (ref ${obs?.eventId}).`);
    expect(textOf(result)).not.toContain('/home/secret');
    expect(h.logger.find('tool failed')).toBeDefined();
  });

  it('unknown tool names are protocol errors and are not observed', async () => {
    h = await createToolHarness();
    const before = h.observations().length;
    await expect(h.client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(
      /not found/,
    );
    expect(h.observations().length).toBe(before);
  });

  it('a registered secret never reaches the text, structured content or the observation', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const marker = 'MARKER-SECRET-4242';
    h.secrets.add(marker);
    handle().firstPage.script.html = `<p>${marker}</p>`;
    const ok = await h.call('get_content', { session_id: id });
    handle().firstPage.failWith('evaluate', new Error(`page.evaluate: Error: ${marker}`));
    const failed = await h.call('evaluate', { session_id: id, expression: '1' });
    for (const payload of [ok, failed, ...h.observations()]) {
      expect(JSON.stringify(payload)).not.toContain(marker);
    }
  });

  it('opens an mcp.tool_call span with the catalog attributes, parented on _meta.traceparent', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    h = await createToolHarness({ tracer: provider.getTracer('test') });
    const id = await h.launch();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await h.client.callTool({
      name: 'snapshot',
      arguments: { session_id: id },
      _meta: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    const span = exporter.getFinishedSpans().find((s) => s.spanContext().traceId === traceId);
    expect(span?.name).toBe('mcp.tool_call');
    expect(span?.attributes).toMatchObject({
      'browserhive.tool': 'snapshot',
      'browserhive.session_id': id,
      'browserhive.principal': 'local',
      'browserhive.ok': true,
    });
    expect(h.observations().at(-1)?.traceId).toBe(traceId);
  });
});
