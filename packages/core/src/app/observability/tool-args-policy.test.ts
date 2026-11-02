/** @module app/observability/tool-args-policy.test — D-47: arguments up to 64 KiB stored whole, larger ones as a valid marker within the cap. */
import { describe, expect, it } from 'bun:test';
import { TOOL_ARGS_CAP_BYTES, TruncatedToolArgs } from '@browserhive/contracts/http';
import { capToolArgs } from './tool-args-policy.ts';

const encoder = new TextEncoder();
const MIB = 1024 * 1024;

function storedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** `{"s":"…"}` is the string plus 8 bytes of JSON. */
function argsOfSize(bytes: number, unit = 'a'): { s: string } {
  return { s: unit.repeat(bytes - 8) };
}

describe('tool args policy (D-47)', () => {
  it('keeps arguments up to the cap unchanged, the boundary included', () => {
    const small = { url: 'https://example.com', selector: '#go' };
    expect(capToolArgs(small)).toBe(small);
    const atCap = argsOfSize(TOOL_ARGS_CAP_BYTES);
    expect(storedBytes(atCap)).toBe(TOOL_ARGS_CAP_BYTES);
    expect(capToolArgs(atCap)).toBe(atCap);
  });

  it('turns arguments one byte over the cap into a marker within the cap', () => {
    const over = argsOfSize(TOOL_ARGS_CAP_BYTES + 1);
    const out = TruncatedToolArgs.parse(capToolArgs(over));
    expect(out.bytes).toBe(TOOL_ARGS_CAP_BYTES + 1);
    expect(storedBytes(out)).toBeLessThanOrEqual(TOOL_ARGS_CAP_BYTES);
    expect(JSON.stringify(over).startsWith(out.preview)).toBe(true);
  });

  it('stores a 4 MiB call as at most 64 KiB, with the longest preview that fits', () => {
    const huge = { session_id: 'shop-00000001', text: 'a'.repeat(4 * MIB) };
    const serialized = JSON.stringify(huge);
    const out = TruncatedToolArgs.parse(capToolArgs(huge));
    expect(out.bytes).toBe(encoder.encode(serialized).length);
    expect(serialized.startsWith(out.preview)).toBe(true);
    const size = storedBytes(out);
    expect(size).toBeLessThanOrEqual(TOOL_ARGS_CAP_BYTES);
    // ASCII costs one byte per character, so the longest preview fills the cap exactly.
    expect(size).toBe(TOOL_ARGS_CAP_BYTES);
  });

  it('accounts for escaping in the preview', () => {
    const quoted = { s: '"\\'.repeat(100_000) };
    const out = TruncatedToolArgs.parse(capToolArgs(quoted));
    expect(storedBytes(out)).toBeLessThanOrEqual(TOOL_ARGS_CAP_BYTES);
    expect(JSON.stringify(quoted).startsWith(out.preview)).toBe(true);
    expect(TruncatedToolArgs.parse(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });

  it('never splits a surrogate pair or a multi-byte character', () => {
    for (const unit of ['😀', 'é', '中']) {
      const out = TruncatedToolArgs.parse(capToolArgs({ s: unit.repeat(100_000) }));
      expect(storedBytes(out)).toBeLessThanOrEqual(TOOL_ARGS_CAP_BYTES);
      expect(out.preview).not.toMatch(/[\ud800-\udbff]$/);
      expect(out.preview.endsWith(unit)).toBe(true);
    }
  });

  it('honours a smaller cap', () => {
    const out = TruncatedToolArgs.parse(capToolArgs({ s: 'a'.repeat(1000) }, 100));
    expect(storedBytes(out)).toBeLessThanOrEqual(100);
    expect(out.bytes).toBe(1008);
    expect(out.preview.startsWith('{"s":"aaa')).toBe(true);
  });
});
