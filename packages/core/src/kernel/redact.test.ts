/** @module kernel/redact.test — key heuristics, value patterns, windowed registry and the marker property. */

import { describe, expect, it } from 'bun:test';
import {
  CIRCULAR,
  createRedactor,
  isSensitiveKey,
  REDACTED,
  redactKeys,
  SecretRegistry,
  scrubPatterns,
  TRUNCATED,
} from './redact.ts';
import { secret } from './secret.ts';

function registryAt(start = 1_000): { registry: SecretRegistry; advance: (ms: number) => void } {
  let now = start;
  const registry = new SecretRegistry({ now: () => now });
  return {
    registry,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('isSensitiveKey / redactKeys', () => {
  it('matches the sensitive key patterns case-insensitively', () => {
    for (const k of ['password', 'PASSWD', 'apiKey', 'Authorization', 'x-auth_token', 'cookie']) {
      expect(isSensitiveKey(k)).toBe(true);
    }
    expect(isSensitiveKey('username')).toBe(false);
    expect(isSensitiveKey('url')).toBe(false);
  });

  it('deep-clones with sensitive keys replaced', () => {
    const out = redactKeys({
      user: 'amir',
      password: 'p',
      nested: { token: 't', list: [{ secret: 's' }, 1] },
    });
    expect(out).toEqual({
      user: 'amir',
      password: REDACTED,
      nested: { token: REDACTED, list: [{ secret: REDACTED }, 1] },
    });
  });

  it('replaces Secret values with the placeholder', () => {
    expect(redactKeys({ value: secret('x') })).toEqual({ value: '[secret]' });
  });

  it('caps depth and breaks cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(redactKeys(cyclic)).toEqual({ a: 1, self: CIRCULAR });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i += 1) deep = { d: deep };
    expect(JSON.stringify(redactKeys(deep, 3))).toContain(TRUNCATED);
  });
});

describe('scrubPatterns', () => {
  it('scrubs bearer tokens and URL userinfo', () => {
    expect(scrubPatterns('Authorization: Bearer abcdefgh.ijklmnop')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(scrubPatterns('fetch https://amir:hunter2@example.com/x')).toBe(
      `fetch https://${REDACTED}@example.com/x`,
    );
  });

  it('leaves ordinary prose alone', () => {
    expect(scrubPatterns('the bearer of bad news')).toBe('the bearer of bad news');
  });
});

describe('SecretRegistry', () => {
  it('ignores literals shorter than 3 chars', () => {
    const { registry } = registryAt();
    registry.add('ab');
    expect(registry.size()).toBe(0);
    expect(registry.scrub('ab')).toBe('ab');
  });

  it('scrubs always-on literals everywhere in the text', () => {
    const { registry } = registryAt();
    registry.add('tok-123');
    expect(registry.scrub('a tok-123 b tok-123')).toBe(`a ${REDACTED} b ${REDACTED}`);
    registry.delete('tok-123');
    expect(registry.scrub('tok-123')).toBe('tok-123');
  });

  it('opens a window that expires against the injected clock', () => {
    const { registry, advance } = registryAt();
    registry.openWindow('s1', ['hunter2'], 5_000);
    expect(registry.isWindowOpen('s1')).toBe(true);
    expect(registry.scrub('pw=hunter2')).toBe(`pw=${REDACTED}`);
    advance(5_001);
    expect(registry.scrub('pw=hunter2')).toBe('pw=hunter2');
    expect(registry.isWindowOpen('s1')).toBe(false);
  });

  it('re-arming extends the deadline and unions the set', () => {
    const { registry, advance } = registryAt();
    registry.openWindow('s1', ['alpha1'], 1_000);
    advance(800);
    registry.openWindow('s1', ['beta22'], 1_000);
    advance(800);
    expect(registry.scrub('alpha1 beta22')).toBe(`${REDACTED} ${REDACTED}`);
  });

  it('ref-counts a literal shared by two windows', () => {
    const { registry } = registryAt();
    registry.openWindow('s1', ['shared-secret'], 10_000);
    registry.openWindow('s2', ['shared-secret'], 10_000);
    registry.closeWindow('s1');
    expect(registry.scrub('shared-secret')).toBe(REDACTED);
    registry.closeWindow('s2');
    expect(registry.scrub('shared-secret')).toBe('shared-secret');
  });

  it('scrubs longest literal first so a prefix does not mangle a longer secret', () => {
    const { registry } = registryAt();
    registry.add('abc');
    registry.add('abcdef');
    expect(registry.scrub('x abcdef y')).toBe(`x ${REDACTED} y`);
  });

  it('scrubValue walks nested strings', () => {
    const { registry } = registryAt();
    registry.add('hunter2');
    expect(registry.scrubValue({ a: ['hunter2'], b: { c: 'say hunter2' }, n: 1 })).toEqual({
      a: [REDACTED],
      b: { c: `say ${REDACTED}` },
      n: 1,
    });
  });

  it('closeAllWindows and clear release everything', () => {
    const { registry } = registryAt();
    registry.add('always-on');
    registry.openWindow('s1', ['windowed'], 10_000);
    registry.closeAllWindows();
    expect(registry.has('windowed')).toBe(false);
    expect(registry.has('always-on')).toBe(true);
    registry.clear();
    expect(registry.size()).toBe(0);
  });
});

describe('createRedactor', () => {
  it('applies keys, patterns and literals', () => {
    const { registry } = registryAt();
    registry.add('hunter2');
    const redactor = createRedactor(registry);
    expect(redactor.scrubText('Bearer abcdefghijkl and hunter2')).toBe(
      `Bearer ${REDACTED} and ${REDACTED}`,
    );
    expect(redactor.redactValue({ password: 'x', note: 'hunter2' })).toEqual({
      password: REDACTED,
      note: REDACTED,
    });
  });

  it('works without a registry', () => {
    const redactor = createRedactor();
    expect(redactor.redactValue({ token: 'x' })).toEqual({ token: REDACTED });
  });
});

/** Small seeded PRNG (mulberry32) so the property run is deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{};:,.<>/?~` \n\t"\'\\';

function randomString(rnd: () => number, min: number, max: number): string {
  const len = min + Math.floor(rnd() * (max - min + 1));
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)] ?? 'a';
  return out;
}

describe('property: a registered marker never survives scrub', () => {
  it('holds over 1000 seeded cases with random payloads and placements', () => {
    const rnd = prng(0xbeef);
    for (let i = 0; i < 1000; i += 1) {
      const { registry } = registryAt();
      const markers: string[] = [];
      const count = 1 + Math.floor(rnd() * 3);
      for (let m = 0; m < count; m += 1) {
        let marker = randomString(rnd, 3, 24);
        // A marker that is itself a substring of the placeholder cannot be redacted by definition.
        while (REDACTED.includes(marker)) marker = randomString(rnd, 3, 24);
        markers.push(marker);
        if (rnd() < 0.5) registry.add(marker);
        else registry.openWindow(`s${m}`, [marker], 10_000);
      }
      // Build a payload with markers embedded at random positions, possibly adjacent/overlapping.
      let payload = randomString(rnd, 0, 40);
      for (let k = 0; k < 4; k += 1) {
        const marker = markers[Math.floor(rnd() * markers.length)] ?? '';
        const at = Math.floor(rnd() * (payload.length + 1));
        payload = `${payload.slice(0, at)}${marker}${payload.slice(at)}`;
      }
      const scrubbedText = registry.scrub(payload);
      const scrubbedValue = registry.scrubValue({
        msg: payload,
        nested: [payload, { deep: payload }],
      });
      const leaves: string[] = [];
      const collect = (v: unknown): void => {
        if (typeof v === 'string') leaves.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (typeof v === 'object' && v !== null) Object.values(v).forEach(collect);
      };
      collect(scrubbedValue);
      expect(leaves.length).toBe(3);
      for (const marker of markers) {
        expect(scrubbedText.includes(marker)).toBe(false);
        for (const leaf of leaves) expect(leaf.includes(marker)).toBe(false);
      }
    }
  });
});
