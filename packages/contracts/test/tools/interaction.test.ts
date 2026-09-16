/** @module contracts/test/tools/interaction.test — scroll superRefine and interaction input constraints */
/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import { CLICK, SCROLL, ScrollInput, SELECT_OPTION } from '../../src/tools/interaction.ts';

describe('scroll input (flat object + superRefine)', () => {
  it('applies the defaults for mode="by"', () => {
    const parsed = ScrollInput.parse({ session_id: 's', mode: 'by' });
    expect(parsed).toEqual({
      session_id: 's',
      mode: 'by',
      dx: 0,
      dy: 0,
      behavior: 'auto',
      timeout: 30_000,
    });
    expect(SCROLL.input).toBe(ScrollInput);
  });

  it('requires x and y for mode="to"', () => {
    const result = ScrollInput.safeParse({ session_id: 's', mode: 'to', x: 10 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toEqual(['mode="to" requires x and y']);
    }
    expect(ScrollInput.safeParse({ session_id: 's', mode: 'to', x: 10, y: 0 }).success).toBe(true);
  });

  it('requires selector for mode="selector"', () => {
    const result = ScrollInput.safeParse({ session_id: 's', mode: 'selector' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toEqual([
        'mode="selector" requires selector',
      ]);
    }
    expect(ScrollInput.safeParse({ session_id: 's', mode: 'selector', selector: '' }).success).toBe(
      false,
    );
    expect(
      ScrollInput.safeParse({ session_id: 's', mode: 'selector', selector: '#a' }).success,
    ).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(ScrollInput.safeParse({ session_id: 's', mode: 'up' }).success).toBe(false);
  });
});

describe('click / select_option constraints', () => {
  it('bounds click_count to 1..3 and defaults button/timeout', () => {
    const input = CLICK.input;
    expect(input.parse({ session_id: 's', selector: '#a' })).toEqual({
      session_id: 's',
      selector: '#a',
      button: 'left',
      click_count: 1,
      timeout: 30_000,
    });
    expect(input.safeParse({ session_id: 's', selector: '#a', click_count: 4 }).success).toBe(
      false,
    );
    expect(input.safeParse({ session_id: 's', selector: '#a', click_count: 0 }).success).toBe(
      false,
    );
    expect(input.safeParse({ session_id: 's', selector: '', click_count: 1 }).success).toBe(false);
    expect(
      input.safeParse({ session_id: 's', selector: '#a', modifiers: ['Shift', 'Alt'] }).success,
    ).toBe(true);
    expect(input.safeParse({ session_id: 's', selector: '#a', modifiers: ['Ctrl'] }).success).toBe(
      false,
    );
  });

  it('select_option needs at least one value with the stable message', () => {
    const result = SELECT_OPTION.input.safeParse({ session_id: 's', selector: '#a', values: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('values must include at least one option');
    }
  });
});
