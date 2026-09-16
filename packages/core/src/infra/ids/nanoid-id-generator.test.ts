/** @module infra/ids/nanoid-id-generator.test — id formats per D-23. */

import { describe, expect, it } from 'bun:test';
import { parseSessionId } from '../../kernel/slug.ts';
import { createFakeClock } from '../clock/system-clock.ts';
import { createNanoidIdGenerator } from './nanoid-id-generator.ts';

describe('createNanoidIdGenerator', () => {
  const ids = createNanoidIdGenerator({ clock: createFakeClock(1_700_000_000_000) });

  it('mints <slug>-<nanoid8> session ids that parse back', () => {
    const id = ids.sessionId('shop');
    expect(id).toMatch(/^shop-[0-9a-z]{8}$/);
    expect(parseSessionId(id)?.slug).toBe('shop');
  });

  it('mints t-<nanoid6> tab ids', () => {
    expect(ids.tabId()).toMatch(/^t-[0-9a-z]{6}$/);
  });

  it('mints e-<ulid> event ids that sort by time', () => {
    const clock = createFakeClock(1_000);
    const gen = createNanoidIdGenerator({ clock });
    const a = gen.eventId();
    clock.advance(1);
    const b = gen.eventId();
    expect(a).toMatch(/^e-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(a < b).toBe(true);
  });

  it('mints a-<nanoid12> operator request ids and opaque ids of the requested size', () => {
    expect(ids.operatorRequestId()).toMatch(/^a-[A-Za-z0-9_-]{12}$/);
    expect(ids.opaque(32)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(ids.opaque(0)).toHaveLength(1);
  });

  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(ids.tabId());
    expect(seen.size).toBe(500);
  });
});
