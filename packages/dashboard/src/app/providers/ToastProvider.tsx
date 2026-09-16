/** @module app/providers/ToastProvider — Base UI toast manager: max 5, newest on top, 6.5 s TTL, actionable toasts persist; `useToast()` (spec 04 §6.4) */
import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import type { AppError } from '@/lib/api/errors.ts';

/** Toast tone. */
export type ToastType = 'info' | 'success' | 'warning' | 'error';

/** Optional action button. */
export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

/** Per-toast data the stack renders (code token for errors, action). */
export interface ToastData extends Record<string, unknown> {
  readonly code?: string;
  readonly requestId?: string;
  readonly action?: ToastAction;
}

/** Toast input. */
export interface ToastInput {
  readonly title: string;
  readonly description?: string;
  readonly action?: ToastAction;
  /** Stable id: re-issuing the same id updates the toast instead of stacking a duplicate. */
  readonly id?: string;
  /**
   * Keep the toast until dismissed. Defaults to `true` when it has an action (so the operator can
   * still act on it) and `false` otherwise; informational toasts with an action pass `false`.
   */
  readonly persist?: boolean;
}

/** What `useToast()` returns. */
export interface ToastApi {
  readonly info: (input: ToastInput) => string;
  readonly success: (input: ToastInput) => string;
  readonly warning: (input: ToastInput) => string;
  readonly error: (
    input: ToastInput & { readonly code?: string; readonly requestId?: string },
  ) => string;
  /** Standard error toast: title + message + copyable code + request id. */
  readonly fromError: (error: AppError, title?: string) => string;
  readonly close: (id: string) => void;
  /** Change a toast that is still shown; does nothing once it has closed (never re-raises it). */
  readonly update: (
    id: string,
    patch: { readonly title?: string; readonly description?: string },
  ) => void;
}

/** Limits (spec 04 §6.4). */
export const TOAST_LIMIT = 5;
/** Auto-dismiss (spec 04 §6.4). */
export const TOAST_TTL_MS = 6_500;

const ToastContext = createContext<ToastApi | null>(null);
const ManagerContext = createContext<ReturnType<typeof ToastPrimitive.createToastManager> | null>(
  null,
);

/** Owns one toast manager per app instance. */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [manager] = useState(() => ToastPrimitive.createToastManager<ToastData>());
  const api = useMemo<ToastApi>(() => {
    const add = (type: ToastType, input: ToastInput, data: ToastData = {}): string =>
      manager.add({
        type,
        title: input.title,
        ...(input.description !== undefined && { description: input.description }),
        ...(input.id !== undefined && { id: input.id }),
        priority: type === 'error' ? 'high' : 'low',
        timeout: (input.persist ?? input.action !== undefined) ? 0 : TOAST_TTL_MS,
        data: { ...data, ...(input.action !== undefined && { action: input.action }) },
        ...(input.action !== undefined && {
          actionProps: { children: input.action.label, onClick: input.action.onClick },
        }),
      });
    return {
      info: (input) => add('info', input),
      success: (input) => add('success', input),
      warning: (input) => add('warning', input),
      error: ({ code, requestId, ...input }) =>
        add('error', input, {
          ...(code !== undefined && { code }),
          ...(requestId !== undefined && { requestId }),
        }),
      fromError: (error, title) =>
        add(
          'error',
          { title: title ?? error.title, description: error.message },
          {
            code: error.code,
            ...(error.requestId !== undefined && { requestId: error.requestId }),
          },
        ),
      close: (id) => manager.close(id),
      update: (id, patch) => manager.update(id, patch),
    };
  }, [manager]);
  return (
    <ManagerContext.Provider value={manager}>
      <ToastContext.Provider value={api}>
        <ToastPrimitive.Provider toastManager={manager} limit={TOAST_LIMIT} timeout={TOAST_TTL_MS}>
          {children}
        </ToastPrimitive.Provider>
      </ToastContext.Provider>
    </ManagerContext.Provider>
  );
}

/** Raise toasts. */
export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (value === null) throw new Error('useToast() requires ToastProvider');
  return value;
}
