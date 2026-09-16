/** @module interface/ws/live-input — LiveInput → CDP `Input.dispatch*Event` parameters (defaults for omitted fields). */

import type { KeyInput, MouseInput, TouchInput } from '@browserhive/contracts/ws';
import type { z } from 'zod';

/** `Input.dispatchMouseEvent` params. */
export interface MouseEventParams {
  readonly type: z.output<typeof MouseInput>['action'];
  readonly x: number;
  readonly y: number;
  readonly button: 'none' | 'left' | 'middle' | 'right';
  readonly clickCount: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly modifiers: number;
}

/** `Input.dispatchKeyEvent` params. */
export interface KeyEventParams {
  readonly type: z.output<typeof KeyInput>['action'];
  readonly key?: string;
  readonly code?: string;
  readonly text?: string;
  readonly windowsVirtualKeyCode?: number;
  readonly modifiers: number;
}

/** `Input.dispatchTouchEvent` params. */
export interface TouchEventParams {
  readonly type: z.output<typeof TouchInput>['action'];
  readonly touchPoints: readonly {
    readonly x: number;
    readonly y: number;
    readonly radiusX?: number;
    readonly radiusY?: number;
    readonly force?: number;
    readonly id?: number;
  }[];
  readonly modifiers: number;
}

/** Mouse: button defaults to `left`, clickCount to 1 for press/release (0 for moves), matching a plain click. */
export function mouseParams(input: z.output<typeof MouseInput>): MouseEventParams {
  const pressOrRelease = input.action === 'mousePressed' || input.action === 'mouseReleased';
  return {
    type: input.action,
    x: input.x,
    y: input.y,
    button: input.button ?? 'left',
    clickCount: input.clickCount ?? (pressOrRelease ? 1 : 0),
    ...(input.deltaX !== undefined && { deltaX: input.deltaX }),
    ...(input.deltaY !== undefined && { deltaY: input.deltaY }),
    modifiers: input.modifiers ?? 0,
  };
}

/** Keyboard. */
export function keyParams(input: z.output<typeof KeyInput>): KeyEventParams {
  return {
    type: input.action,
    ...(input.key !== undefined && { key: input.key }),
    ...(input.code !== undefined && { code: input.code }),
    ...(input.text !== undefined && { text: input.text }),
    ...(input.windowsVirtualKeyCode !== undefined && {
      windowsVirtualKeyCode: input.windowsVirtualKeyCode,
    }),
    modifiers: input.modifiers ?? 0,
  };
}

/** Touch. */
export function touchParams(input: z.output<typeof TouchInput>): TouchEventParams {
  return {
    type: input.action,
    touchPoints: input.points.map((p) => ({
      x: p.x,
      y: p.y,
      ...(p.radiusX !== undefined && { radiusX: p.radiusX }),
      ...(p.radiusY !== undefined && { radiusY: p.radiusY }),
      ...(p.force !== undefined && { force: p.force }),
      ...(p.id !== undefined && { id: p.id }),
    })),
    modifiers: input.modifiers ?? 0,
  };
}
