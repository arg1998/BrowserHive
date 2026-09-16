/** @module app/shell/ToastStack — toast cards (tinted icon, 14px title, 13px description, action, close) stacked bottom-right, above the page but below popovers and modal dialogs; error toasts carry a copyable code; status/alert live regions */
import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import type { ToastData } from '@/app/providers/ToastProvider.tsx';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

const TONE = {
  info: { icon: ICONS.info, className: 'bg-info-bg text-info-text' },
  success: { icon: ICONS.success, className: 'bg-success-bg text-success-text' },
  warning: { icon: ICONS.warn, className: 'bg-warn-bg text-warn-text' },
  error: { icon: ICONS.error, className: 'bg-danger-bg text-danger-text' },
} as const;

/** Toast stack. */
export function ToastStack() {
  const { toasts } = ToastPrimitive.useToastManager<ToastData>();
  const alerts = toasts.filter((t) => t.type === 'error');
  const statuses = toasts.filter((t) => t.type !== 'error');
  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {statuses.map((t) => (
          <p key={t.id}>{String(t.title ?? '')}</p>
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="sr-only">
        {alerts.map((t) => (
          <p key={t.id}>{String(t.title ?? '')}</p>
        ))}
      </div>
      <ToastPortal>
        <ToastViewport className="z-(--z-toast)" aria-label="Notifications">
          {toasts.map((item) => {
            const type =
              item.type === 'success' || item.type === 'warning' || item.type === 'error'
                ? item.type
                : 'info';
            const tone = TONE[type];
            const Icon = tone.icon;
            return (
              <Toast key={item.id} toast={item}>
                <ToastContent>
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full',
                      tone.className,
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1.5">
                    <ToastTitle />
                    <ToastDescription className="[overflow-wrap:anywhere]" />
                    {item.data?.code !== undefined ? (
                      <span className="inline-flex flex-wrap items-center gap-x-1 font-mono text-xs text-muted-foreground">
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground dark:bg-white/[0.07]">
                          {item.data.code}
                        </span>
                        <CopyButton
                          value={item.data.code}
                          label={`Copy error code ${item.data.code}`}
                          visibility="always"
                        />
                        {item.data.requestId !== undefined ? (
                          <span>· req {item.data.requestId}</span>
                        ) : null}
                      </span>
                    ) : null}
                    {item.actionProps !== undefined ? (
                      <div className="pt-1.5">
                        <ToastAction />
                      </div>
                    ) : null}
                  </div>
                  <ToastClose />
                </ToastContent>
              </Toast>
            );
          })}
        </ToastViewport>
      </ToastPortal>
    </>
  );
}
