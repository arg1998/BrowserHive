/** @module features/sessions/live/input-mapping.test — letterbox + DPR scaling math, modifier bitmask, VK codes, key text rules, mouse buttons */
import { describe, expect, it } from 'bun:test';
import {
  cdpModifiers,
  keyInput,
  letterboxRect,
  mouseButton,
  shouldPreventKey,
  toPageCoords,
  virtualKeyCode,
} from './input-mapping.ts';

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe('takeover coordinate mapping', () => {
  it('computes letterbox bars for wide and tall frames', () => {
    expect(letterboxRect({ width: 800, height: 800 }, { width: 1600, height: 900 })).toEqual({
      x: 0,
      y: 175,
      width: 800,
      height: 450,
    });
    expect(letterboxRect({ width: 800, height: 450 }, { width: 900, height: 1600 })).toEqual({
      x: (800 - 450 * (900 / 1600)) / 2,
      y: 0,
      width: 450 * (900 / 1600),
      height: 450,
    });
  });

  it('scales into the device viewport (DPR-correct) and ignores clicks in the bars', () => {
    const box = { width: 800, height: 800 };
    const frame = { width: 1920, height: 1080 };
    const device = { width: 960, height: 540 };
    expect(toPageCoords({ x: 400, y: 400 }, box, frame, device)).toEqual({ x: 480, y: 270 });
    expect(toPageCoords({ x: 0, y: 175 }, box, frame, device)).toEqual({ x: 0, y: 0 });
    expect(toPageCoords({ x: 800, y: 625 }, box, frame, device)).toEqual({ x: 960, y: 540 });
    expect(toPageCoords({ x: 400, y: 100 }, box, frame, device)).toBeNull();
    expect(toPageCoords({ x: 400, y: 400 }, box, frame, null)).toEqual({ x: 960, y: 540 });
    expect(toPageCoords({ x: 1, y: 1 }, { width: 0, height: 0 }, frame, device)).toBeNull();
  });
});

describe('keyboard mapping', () => {
  it('builds the CDP modifier bitmask', () => {
    expect(cdpModifiers(none)).toBe(0);
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(cdpModifiers({ ...none, shiftKey: true })).toBe(8);
  });

  it('maps virtual key codes', () => {
    expect(virtualKeyCode('Enter')).toBe(13);
    expect(virtualKeyCode('a')).toBe(65);
    expect(virtualKeyCode('7')).toBe(55);
    expect(virtualKeyCode('F5')).toBeUndefined();
  });

  it('sends text only for printable keyDown without command modifiers', () => {
    expect(keyInput('keyDown', { ...none, key: 'x', code: 'KeyX' })).toEqual({
      type: 'key',
      action: 'keyDown',
      key: 'x',
      code: 'KeyX',
      text: 'x',
      windowsVirtualKeyCode: 88,
      modifiers: 0,
    });
    expect(keyInput('keyUp', { ...none, key: 'x', code: 'KeyX' })).not.toHaveProperty('text');
    expect(
      keyInput('keyDown', { ...none, ctrlKey: true, key: 'a', code: 'KeyA' }),
    ).not.toHaveProperty('text');
    expect(shouldPreventKey({ ...none, metaKey: true })).toBe(false);
    expect(shouldPreventKey(none)).toBe(true);
  });

  it('maps mouse buttons', () => {
    expect([0, 1, 2, 3].map(mouseButton)).toEqual(['left', 'middle', 'right', 'none']);
  });
});
