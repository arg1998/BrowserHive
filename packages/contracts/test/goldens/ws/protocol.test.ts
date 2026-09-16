/// <reference types="bun-types" />
/** @module contracts/test/goldens/ws/protocol.test — JSON Schema of the envelope, commands, messages and feed payloads (spec 09 §3.1) */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  WsClientCommand,
  WsEnvelope,
  WsFeedEvent,
  WsServerMessage,
} from '../../../src/ws/index.ts';

const GOLDEN = new URL('./ws-protocol.json', import.meta.url).pathname;
const UPDATE = Bun.env['UPDATE_GOLDENS'] === '1';

function render(): string {
  const doc = {
    envelope: z.toJSONSchema(WsEnvelope, { unrepresentable: 'any' }),
    client_commands: z.toJSONSchema(WsClientCommand, { unrepresentable: 'any' }),
    server_messages: z.toJSONSchema(WsServerMessage, { unrepresentable: 'any' }),
    feed_events: z.toJSONSchema(WsFeedEvent, { unrepresentable: 'any' }),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

describe('ws protocol JSON Schema golden', () => {
  it('is deterministic', () => {
    expect(render()).toBe(render());
  });
  it('matches the committed golden (UPDATE_GOLDENS=1 to bless)', async () => {
    const rendered = render();
    if (UPDATE) {
      await Bun.write(GOLDEN, rendered);
      return;
    }
    const committed = await Bun.file(GOLDEN).text();
    expect(JSON.parse(committed)).toEqual(JSON.parse(rendered));
  });
});
