/** @module interface/ws/feed-buffer.test — ordered replay, count/bytes/age bounds, expired cursors. */

import { describe, expect, it } from 'bun:test';
import { FeedBuffer } from './feed-buffer.ts';

function buffer(limits: { count: number; bytes: number; ageMs: number }) {
  let now = 1000;
  const feed = new FeedBuffer(limits, () => now);
  return { feed, advance: (ms: number) => (now += ms) };
}

describe('FeedBuffer', () => {
  it('assigns monotonic seqs and replays matching topics in order', () => {
    const { feed } = buffer({ count: 10, bytes: 10_000, ageMs: 60_000 });
    for (const topic of ['a', 'b', 'a', 'a']) feed.append(topic, (seq) => `${topic}${seq}`);
    const replay = feed.replay(1, (t) => t === 'a');
    expect(replay.complete && replay.frames.map((f) => f.text)).toEqual(['a3', 'a4']);
    expect(feed.head).toBe(4);
  });

  it('evicts by count and reports an expired cursor', () => {
    const { feed } = buffer({ count: 2, bytes: 10_000, ageMs: 60_000 });
    for (let i = 0; i < 5; i += 1) feed.append('a', (seq) => `x${seq}`);
    expect(feed.size).toBe(2);
    expect(feed.replay(1, () => true).complete).toBe(false);
    expect(feed.replay(3, () => true).complete).toBe(true);
    expect(feed.replay(5, () => true)).toEqual({ complete: true, frames: [] });
    expect(feed.replay(9, () => true).complete).toBe(false);
  });

  it('evicts by bytes and by age', () => {
    const bytes = buffer({ count: 100, bytes: 10, ageMs: 60_000 });
    bytes.feed.append('a', () => '123456');
    bytes.feed.append('a', () => '123456');
    expect(bytes.feed.size).toBe(1);
    const age = buffer({ count: 100, bytes: 10_000, ageMs: 100 });
    age.feed.append('a', () => 'old');
    age.advance(500);
    expect(age.feed.replay(0, () => true).complete).toBe(false);
  });
});
