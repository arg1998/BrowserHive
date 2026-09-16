/** @module app/config/names.property.test — unit tests for names.property */
import { describe, expect, it } from 'bun:test';
import { CONFIG_KEYS, lookupKey, namesFor } from '@browserhive/contracts/config';
import { tokenizeArgs } from './argv.ts';
import { collectCliLayer, collectEnvLayer, collectFileLayer } from './layers.ts';
import { isRegisteredSpelling } from './suggest.ts';

/** Deterministic xorshift PRNG so the property run is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const WORDS = [
  'max',
  'sessions',
  'otel',
  'endpoint',
  'allow',
  'insecure',
  'bind',
  'log',
  'level',
  'x',
  'y2',
];

function randomCamelKey(random: () => number): string {
  const count = 1 + Math.floor(random() * 3);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) parts.push(WORDS[Math.floor(random() * WORDS.length)] ?? 'x');
  return parts
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

describe('spelling round-trip (property)', () => {
  it('every registered key round-trips through env, cli and json spellings', () => {
    for (const key of CONFIG_KEYS) {
      const names = namesFor(key);
      expect(lookupKey('env', names.env)).toEqual({ kind: 'key', key });
      expect(lookupKey('cli', names.cli)).toEqual({ kind: 'key', key });
      expect(lookupKey('json', names.json)).toEqual({ kind: 'key', key });
      expect(isRegisteredSpelling('cli', names.cli)).toBe(true);
    }
  });

  it('the three collectors agree on the canonical key for every registered key', () => {
    for (const key of CONFIG_KEYS) {
      const names = namesFor(key);
      const env = collectEnvLayer({ [names.env]: 'v' });
      const cli = collectCliLayer(tokenizeArgs([`${names.cli}=v`]));
      const file = collectFileLayer({ [names.json]: 'v' }, '/work/browserhive.config.json');
      expect([...env.entries.keys()]).toEqual([key]);
      expect([...cli.entries.keys()]).toEqual([key]);
      if (key === 'config') expect(file.problems).toHaveLength(1);
      else expect([...file.entries.keys()]).toEqual([key]);
    }
  });

  it('random camelCase names either resolve to themselves or are unknown in every spelling', () => {
    const random = prng(0x5eed);
    for (let i = 0; i < 500; i += 1) {
      const name = randomCamelKey(random);
      const names = namesFor(name);
      const viaEnv = lookupKey('env', names.env);
      const viaCli = lookupKey('cli', names.cli);
      const viaJson = lookupKey('json', names.json);
      expect(viaCli).toEqual(viaJson);
      if (viaJson.kind === 'key') {
        expect<string>(viaJson.key).toBe(name);
        expect(viaEnv).toEqual(viaJson);
      } else if (viaJson.kind === 'unknown') {
        // A name absent from the registry never maps back through env either, unless another
        // camelCase spelling shares its SCREAMING_SNAKE form (e.g. `logLevel` vs `logLEVEL`).
        if (viaEnv.kind === 'key') expect(namesFor(viaEnv.key).env).toBe(names.env);
      }
    }
  });
});
