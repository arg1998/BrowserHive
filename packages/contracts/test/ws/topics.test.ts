/// <reference types="bun-types" />
/** @module contracts/test/ws/topics.test — every topic name is a valid WsTopic; parse/build round-trips; scope + event maps cover all topics */
import { describe, expect, it } from 'bun:test';
import { SessionId } from '../../src/ids/index.ts';
import { WS_COMMAND_SCOPES, WS_TOPIC_SCOPES, WsClientCommand } from '../../src/ws/commands.ts';
import { WS_SESSION_TOPIC_EVENTS, WS_TOPIC_EVENTS, WsFeedEvent } from '../../src/ws/feed-events.ts';
import {
  parseTopic,
  screencastTopic,
  sessionTopic,
  WS_STATIC_TOPICS,
  WsTopic,
} from '../../src/ws/topics.ts';

const id = SessionId.parse('shop-a1b2c3d4');

describe('WsTopic', () => {
  it('accepts every static topic', () => {
    for (const t of WS_STATIC_TOPICS) expect(WsTopic.safeParse(t).success).toBe(true);
  });
  it('accepts built session and screencast topics and parses them back', () => {
    expect(WsTopic.parse(sessionTopic(id))).toBe('session:shop-a1b2c3d4');
    expect(parseTopic(sessionTopic(id))).toEqual({ kind: 'session', session_id: id });
    expect(parseTopic(screencastTopic(id))).toEqual({ kind: 'screencast', session_id: id });
    expect(parseTopic('system')).toEqual({ kind: 'static', name: 'system' });
  });
  it('rejects unknown topics, bad ids and foreign prefixes', () => {
    for (const bad of [
      '',
      'session',
      'session:',
      'session:BAD',
      'screencast:t-x7k2m9',
      'tabs:shop-a1b2c3d4',
    ]) {
      expect(WsTopic.safeParse(bad).success).toBe(false);
      expect(parseTopic(bad)).toBeNull();
    }
  });
  it('maps every static topic to a scope and an event list', () => {
    for (const t of WS_STATIC_TOPICS) {
      expect(WS_TOPIC_SCOPES[t]).toBeDefined();
      expect(WS_TOPIC_EVENTS[t].length).toBeGreaterThan(0);
    }
  });
  it('publishes every feed event type on at least one topic', () => {
    const published = new Set<string>([
      ...Object.values(WS_TOPIC_EVENTS).flat(),
      ...WS_SESSION_TOPIC_EVENTS,
    ]);
    for (const option of WsFeedEvent.options) {
      const type = option.shape.type.value;
      expect(published.has(type)).toBe(true);
    }
  });
  it('maps every client command type to a scope entry', () => {
    for (const option of WsClientCommand.options) {
      const type = option.shape.type.value;
      expect(type in WS_COMMAND_SCOPES).toBe(true);
    }
  });
});
