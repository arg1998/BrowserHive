/** @module features/sessions/live/input-mapping — pure takeover math: letterbox-aware, DPR-correct pointer mapping, CDP modifier bitmask, Windows VK codes, key/mouse/touch `LiveInput` builders (spec 04 §12.3.1) */
import type { KeyInput, MouseInput, TouchInput } from '@browserhive/contracts/ws';

/** A size. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A rectangle. */
export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

/** Where a `width×height` frame is drawn inside a `box` with `object-fit: contain`. */
export function letterboxRect(box: Size, frame: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const frameAspect = frame.width / frame.height;
  const boxAspect = box.width / box.height;
  const width = frameAspect > boxAspect ? box.width : box.height * frameAspect;
  const height = frameAspect > boxAspect ? box.width / frameAspect : box.height;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/**
 * Map a point relative to the box's top-left to page CSS pixels. `device` is the page viewport from
 * screencast metadata (falls back to the frame size); clicks in the letterbox bars return `null`.
 */
export function toPageCoords(
  point: { readonly x: number; readonly y: number },
  box: Size,
  frame: Size,
  device: Size | null,
): { readonly x: number; readonly y: number } | null {
  const drawn = letterboxRect(box, frame);
  if (drawn.width === 0 || drawn.height === 0) return null;
  const u = (point.x - drawn.x) / drawn.width;
  const v = (point.y - drawn.y) / drawn.height;
  if (u < 0 || v < 0 || u > 1 || v > 1) return null;
  const target = device !== null && device.width > 0 && device.height > 0 ? device : frame;
  return { x: Math.round(u * target.width), y: Math.round(v * target.height) };
}

/** Modifier flags of a DOM event. */
export interface ModifierState {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(e: ModifierState): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Windows virtual-key codes for non-printable keys (CDP `windowsVirtualKeyCode`). */
export const VIRTUAL_KEYS: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
};

/** VK code for a key: the map above, then letters (upper-case code) and digits. */
export function virtualKeyCode(key: string): number | undefined {
  const mapped = VIRTUAL_KEYS[key];
  if (mapped !== undefined) return mapped;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return undefined;
}

/** Keyboard event fields the builder reads. */
export interface KeyEventLike extends ModifierState {
  readonly key: string;
  readonly code: string;
}

/** Build a key input; printable keys carry `text` on keyDown unless a Ctrl/Meta/Alt shortcut is held. */
export function keyInput(action: 'keyDown' | 'keyUp', e: KeyEventLike): KeyInput {
  const vk = virtualKeyCode(e.key);
  const asText =
    e.key.length === 1 && action === 'keyDown' && !e.ctrlKey && !e.metaKey && !e.altKey;
  return {
    type: 'key',
    action,
    key: e.key.slice(0, 32),
    code: e.code.slice(0, 64),
    ...(asText && { text: e.key }),
    ...(vk !== undefined && { windowsVirtualKeyCode: vk }),
    modifiers: cdpModifiers(e),
  };
}

/** Keys the dashboard must not act on while capturing; browser combos (Meta/Ctrl) pass through. */
export function shouldPreventKey(e: ModifierState): boolean {
  return !e.metaKey && !e.ctrlKey;
}

/** DOM `button` index → CDP button name. */
export function mouseButton(button: number): NonNullable<MouseInput['button']> {
  switch (button) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return 'none';
  }
}

/** Build a mouse input at page coordinates. */
export function mouseInput(
  action: MouseInput['action'],
  at: { readonly x: number; readonly y: number },
  extra: Omit<MouseInput, 'type' | 'action' | 'x' | 'y'> = {},
): MouseInput {
  return { type: 'mouse', action, x: at.x, y: at.y, ...extra };
}

/** Build a touch input from mapped points (unmappable points are dropped). */
export function touchInput(
  action: TouchInput['action'],
  points: readonly { readonly x: number; readonly y: number; readonly id: number }[],
): TouchInput {
  return {
    type: 'touch',
    action,
    points: points
      .slice(0, 10)
      .map((p) => ({ x: p.x, y: p.y, id: Math.min(32, Math.max(0, p.id)) })),
  };
}
