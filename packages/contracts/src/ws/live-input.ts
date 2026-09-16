/** @module contracts/ws/live-input — operator takeover input forwarded to CDP (mouse, keyboard, touch) */
import { z } from 'zod';

/**
 * CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
 * Field names are the CDP `Input.dispatch*Event` names (camelCase) — spec 03 §6.3 mirrors them in `LiveInput`
 * so inputs map 1:1 onto CDP calls, which makes this the one wire shape that is not snake_case.
 */
export const InputModifiers = z.number().int().min(0).max(15);

/** Pointer input (`Input.dispatchMouseEvent`). Bounds keep CDP inputs sane. */
export const MouseInput = z.object({
  type: z.literal('mouse'),
  action: z.enum(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']),
  x: z.number().min(0).max(100_000),
  y: z.number().min(0).max(100_000),
  button: z.enum(['none', 'left', 'middle', 'right']).optional(),
  clickCount: z.number().int().min(0).max(8).optional(),
  deltaX: z.number().min(-10_000).max(10_000).optional(),
  deltaY: z.number().min(-10_000).max(10_000).optional(),
  modifiers: InputModifiers.optional(),
});
/** Pointer input. */
export type MouseInput = z.infer<typeof MouseInput>;

/** Keyboard input (`Input.dispatchKeyEvent`). */
export const KeyInput = z.object({
  type: z.literal('key'),
  action: z.enum(['keyDown', 'keyUp', 'char', 'rawKeyDown']),
  key: z.string().max(32).optional(),
  code: z.string().max(64).optional(),
  text: z.string().max(16).optional(),
  windowsVirtualKeyCode: z.number().int().min(0).max(255).optional(),
  modifiers: InputModifiers.optional(),
});
/** Keyboard input. */
export type KeyInput = z.infer<typeof KeyInput>;

/** One touch point (`Input.TouchPoint`). */
export const TouchPoint = z.object({
  x: z.number().min(0).max(100_000),
  y: z.number().min(0).max(100_000),
  radiusX: z.number().min(0).max(1_000).optional(),
  radiusY: z.number().min(0).max(1_000).optional(),
  force: z.number().min(0).max(1).optional(),
  id: z.number().int().min(0).max(32).optional(),
});
/** One touch point. */
export type TouchPoint = z.infer<typeof TouchPoint>;

/** Touch input (`Input.dispatchTouchEvent`); new in v1 for mobile takeover. */
export const TouchInput = z.object({
  type: z.literal('touch'),
  action: z.enum(['touchStart', 'touchEnd', 'touchMove', 'touchCancel']),
  points: z.array(TouchPoint).max(10),
  modifiers: InputModifiers.optional(),
});
/** Touch input. */
export type TouchInput = z.infer<typeof TouchInput>;

/** Operator takeover input, discriminated on `type`. Shared by WS `input` and `POST /sessions/{id}/input`. */
export const LiveInput = z.discriminatedUnion('type', [MouseInput, KeyInput, TouchInput]);
/** Operator takeover input. */
export type LiveInput = z.infer<typeof LiveInput>;

/** Maximum inputs per `POST /sessions/{id}/input` batch (spec 03 §4.2). */
export const LIVE_INPUT_BATCH_MAX = 64;
