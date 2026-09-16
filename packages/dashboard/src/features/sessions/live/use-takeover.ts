/** @module features/sessions/live/use-takeover — takeover input: pointer (click, double/right/middle, hover @ rAF, drag), non-passive wheel, keyboard with explicit capture, touch, mobile text; sends `input` commands and toasts `INPUT_NOT_PERMITTED` rejections with the code (spec 04 §12.3.1) */
import { SessionId } from '@browserhive/contracts/ids';
import type { LiveInput } from '@browserhive/contracts/ws';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useKeyboardScope } from '@/app/providers/KeyboardProvider.tsx';
import { useSocket } from '@/app/providers/SocketProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import {
  cdpModifiers,
  keyInput,
  mouseButton,
  mouseInput,
  type Size,
  shouldPreventKey,
  toPageCoords,
  touchInput,
} from './input-mapping.ts';
import { commandErrorCode } from './ws-error.ts';

/** Options. */
export interface UseTakeoverOptions {
  readonly sessionId: string;
  /** Takeover allowed (open attention request). The server re-checks every input. */
  readonly enabled: boolean;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly frameSize: Size | null;
  readonly device: RefObject<Size | null>;
}

/** Toast id for rejected inputs (deduped). */
export const INPUT_REJECTED_TOAST_ID = 'live-input-rejected';

/** Takeover hook. */
export function useTakeover({
  sessionId,
  enabled,
  canvasRef,
  frameSize,
  device,
}: UseTakeoverOptions) {
  const socket = useSocket();
  const toast = useToast();
  const [capture, setCapture] = useState(false);
  const [keyCount, setKeyCount] = useState(0);
  const pressed = useRef<ReturnType<typeof mouseButton> | null>(null);
  const move = useRef<LiveInput | null>(null);
  const frame = useRef<number | null>(null);
  const capturing = enabled && capture;
  useKeyboardScope('capture', capturing);
  useEffect(() => {
    if (!enabled) setCapture(false);
  }, [enabled]);

  const send = useCallback(
    (input: LiveInput) => {
      const id = SessionId.safeParse(sessionId);
      if (socket === null || !id.success) return;
      socket.command('input', { session_id: id.data, input }).catch((error: unknown) => {
        const appError = toAppError(error);
        const code = commandErrorCode(error);
        if (code === 'INPUT_NOT_PERMITTED') {
          toast.error({
            id: INPUT_REJECTED_TOAST_ID,
            title: 'Input rejected',
            description: 'Takeover needs an open attention request for this session.',
            code,
          });
        } else {
          toast.fromError(appError, 'Input not delivered');
        }
      });
    },
    [socket, sessionId, toast],
  );

  const map = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (canvas === null || frameSize === null) return null;
      const rect = canvas.getBoundingClientRect();
      return toPageCoords(
        { x: clientX - rect.left, y: clientY - rect.top },
        rect,
        frameSize,
        device.current,
      );
    },
    [canvasRef, frameSize, device],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return;
    const at = map(event.clientX, event.clientY);
    if (at === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (event.pointerType === 'touch') {
      send(touchInput('touchStart', [{ ...at, id: event.pointerId % 32 }]));
      return;
    }
    const button = mouseButton(event.button);
    pressed.current = button;
    send(
      mouseInput('mousePressed', at, {
        button,
        clickCount: Math.max(1, Math.min(8, event.detail)),
        modifiers: cdpModifiers(event),
      }),
    );
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return;
    const at = map(event.clientX, event.clientY);
    if (event.pointerType === 'touch') {
      send(touchInput('touchEnd', at === null ? [] : [{ ...at, id: event.pointerId % 32 }]));
      return;
    }
    if (at === null || pressed.current === null) return;
    send(
      mouseInput('mouseReleased', at, {
        button: pressed.current,
        clickCount: Math.max(1, Math.min(8, event.detail)),
        modifiers: cdpModifiers(event),
      }),
    );
    pressed.current = null;
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return;
    const at = map(event.clientX, event.clientY);
    if (at === null) return;
    move.current =
      event.pointerType === 'touch'
        ? touchInput('touchMove', [{ ...at, id: event.pointerId % 32 }])
        : mouseInput('mouseMoved', at, {
            button: pressed.current ?? 'none',
            modifiers: cdpModifiers(event),
          });
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (move.current !== null) send(move.current);
      move.current = null;
    });
  };
  useEffect(
    () => () => (frame.current === null ? undefined : cancelAnimationFrame(frame.current)),
    [],
  );

  // Wheel: native non-passive so the dashboard does not scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || !enabled) return undefined;
    const onWheel = (event: WheelEvent) => {
      const at = map(event.clientX, event.clientY);
      if (at === null) return;
      event.preventDefault();
      send(
        mouseInput('mouseWheel', at, {
          deltaX: Math.round(event.deltaX),
          deltaY: Math.round(event.deltaY),
          modifiers: cdpModifiers(event),
        }),
      );
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef, enabled, map, send]);

  const onKey = (action: 'keyDown' | 'keyUp') => (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!capturing) return;
    if (action === 'keyDown' && event.key === 'Escape' && event.shiftKey) {
      event.preventDefault();
      setCapture(false);
      return;
    }
    if (shouldPreventKey(event)) event.preventDefault();
    event.stopPropagation();
    if (action === 'keyDown') setKeyCount((n) => n + 1);
    send(keyInput(action, event));
  };

  /** Mobile keyboard: forward composed text as `char` inputs. */
  const sendText = useCallback(
    (text: string) => {
      if (!enabled) return;
      for (const ch of text) send({ type: 'key', action: 'char', text: ch });
    },
    [enabled, send],
  );

  return {
    capture: capturing,
    setCapture,
    keyCount,
    sendText,
    handlers: {
      onPointerDown,
      onPointerUp,
      onPointerMove,
      onContextMenu: (event: { preventDefault: () => void }) => {
        if (enabled) event.preventDefault();
      },
      onKeyDown: onKey('keyDown'),
      onKeyUp: onKey('keyUp'),
    },
  };
}
