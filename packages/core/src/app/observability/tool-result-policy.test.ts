/** @module app/observability/tool-result-policy.test — full/shape/none, 16 KiB cap, redaction. */
import { describe, expect, it } from 'bun:test';
import { createRedactor, SecretRegistry } from '../../kernel/redact.ts';
import {
  applyResultPolicy,
  capUtf8,
  describeShape,
  RESULT_TEXT_CAP_BYTES,
  TRUNCATION_MARKER,
} from './tool-result-policy.ts';

describe('tool result policy (D-20)', () => {
  const registry = new SecretRegistry({ now: () => 0 });
  registry.add('hunter2secret');
  const redactor = createRedactor(registry);

  it('full keeps redacted text under the 16 KiB cap', () => {
    const text = `{"password":"hunter2secret","ok":true}`;
    const out = applyResultPolicy(text, 'full', redactor);
    expect(out).not.toContain('hunter2secret');
    expect(out).toContain('"ok":true');
  });

  it('full caps at 16 KiB of UTF-8 without splitting a code point', () => {
    const text = 'é'.repeat(20_000);
    const out = applyResultPolicy(text, 'full', redactor);
    expect(out).not.toBeNull();
    if (out !== null) {
      expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(RESULT_TEXT_CAP_BYTES);
      expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(out.includes('�')).toBe(false);
    }
  });

  it('capUtf8 leaves short text untouched', () => {
    expect(capUtf8('abc', 10)).toBe('abc');
  });

  it('shape keeps keys and sizes only', () => {
    const out = applyResultPolicy('{"b":1,"a":"hunter2secret"}', 'shape', redactor);
    expect(out).toBe(JSON.stringify({ shape: { type: 'object', keys: ['a', 'b'] }, bytes: 27 }));
    expect(describeShape('[1,2,3]')).toBe(
      JSON.stringify({ shape: { type: 'array', length: 3 }, bytes: 7 }),
    );
    expect(describeShape('not json')).toBe(JSON.stringify({ shape: { type: 'text' }, bytes: 8 }));
  });

  it('none stores nothing; null passes through', () => {
    expect(applyResultPolicy('anything', 'none', redactor)).toBeNull();
    expect(applyResultPolicy(null, 'full', redactor)).toBeNull();
  });
});
