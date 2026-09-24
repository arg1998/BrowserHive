/** @module app/config/secret-literals.test — every secret config key has an extractor, and the extractors pull the right literals. */
import { describe, expect, it } from 'bun:test';
import { CONFIG_KEYS, keyMeta } from '@browserhive/contracts/config';
import { SecretRegistry } from '../../kernel/redact.ts';
import { SECRET_LITERAL_EXTRACTORS, secretConfigLiterals } from './secret-literals.ts';
import { resolveOk, TOKEN_A, TOKEN_B } from './test-support.ts';

const TOKEN = 't'.repeat(40);

describe('secret config literals (spec 10 §9)', () => {
  it('has an extractor for exactly the keys flagged secret', () => {
    const flagged = CONFIG_KEYS.filter((key) => keyMeta(key).secret).sort();
    expect(Object.keys(SECRET_LITERAL_EXTRACTORS).sort()).toEqual(flagged);
  });

  it('registers the token of each name:token pair, never the name', () => {
    const { config } = resolveOk({ env: { BROWSERHIVE_AUTH_TOKENS: `${TOKEN_A},${TOKEN_B}` } });
    const literals = secretConfigLiterals(config);
    expect(literals).toContain('a'.repeat(32));
    expect(literals).toContain('b'.repeat(32));
    expect(literals).not.toContain('agent-a');
    expect(literals).not.toContain('agent-b');
  });

  it('registers header values and the credential after a scheme, never the scheme word', () => {
    const { config } = resolveOk({
      env: {
        BROWSERHIVE_OTEL: 'true',
        BROWSERHIVE_OTEL_HEADERS: `authorization=Bearer ${TOKEN},x-scope-orgid=tenant-7`,
      },
    });
    const literals = secretConfigLiterals(config);
    expect(literals).toContain(`Bearer ${TOKEN}`);
    expect(literals).toContain(TOKEN);
    expect(literals).toContain('tenant-7');
    expect(literals).not.toContain('Bearer');
  });

  it('is empty for the defaults', () => {
    expect(secretConfigLiterals(resolveOk().config)).toEqual([]);
  });

  it('once registered, a config secret is scrubbed from any later output', () => {
    const { config } = resolveOk({
      env: {
        BROWSERHIVE_AUTH_TOKENS: `ci:${TOKEN}`,
        BROWSERHIVE_OTEL: 'true',
        BROWSERHIVE_OTEL_HEADERS: `api-key=${TOKEN}`,
      },
    });
    const registry = new SecretRegistry({ now: () => 0 });
    for (const literal of secretConfigLiterals(config)) registry.add(literal);
    const scrubbed = registry.scrub(`request failed: Authorization: Bearer ${TOKEN} for ci`);
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain('Bearer');
    expect(scrubbed).toContain('for ci');
  });
});
