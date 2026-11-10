/** @module interface/mcp/shape.test — the redaction walk over shaped results (spec 02 §2.3, spec 13 §5.4): text blocks, structured content at any depth, keys, `_meta`. */
import { describe, expect, it } from 'bun:test';
import { redactShaped, type ShapedResult } from './shape.ts';

const SECRET = 'secret-value-0123456789';
const scrub = (text: string): string => text.split(SECRET).join('[sealed]');

function nested(depth: number, leaf: unknown): unknown {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = { level: value };
  return value;
}

describe('redactShaped', () => {
  it('redacts structured content nested deeper than the walk (40 levels)', () => {
    const shaped: ShapedResult = {
      content: [{ type: 'text', text: 'x' }],
      structuredContent: { deep: nested(40, `has ${SECRET}`) },
    };
    const out = JSON.stringify(redactShaped(shaped, scrub));
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[sealed]');
  });

  it('redacts keys, text blocks and _meta', () => {
    const shaped: ShapedResult = {
      content: [{ type: 'text', text: `a ${SECRET}` }],
      structuredContent: { [SECRET]: 'value' },
      _meta: { note: SECRET },
    };
    expect(JSON.stringify(redactShaped(shaped, scrub))).not.toContain(SECRET);
  });
});
