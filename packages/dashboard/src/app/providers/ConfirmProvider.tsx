/** @module app/providers/ConfirmProvider — `useConfirm()` → `confirm(options): Promise<boolean>` over one ConfirmDialog (spec 04 §7) */
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import { ConfirmDialog, type ConfirmOptions } from '@/components/shared/ConfirmDialog.tsx';

/** Confirm function. */
export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm {
  readonly options: ConfirmOptions;
  readonly resolve: (confirmed: boolean) => void;
}

/** Renders the shared dialog; only one confirmation is open at a time (a second one cancels the first). */
export function ConfirmProvider({ children }: { readonly children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise((resolve) => {
        setPending((current) => {
          current?.resolve(false);
          return { options, resolve };
        });
      }),
    [],
  );
  const onResult = (confirmed: boolean) => {
    setPending((current) => {
      current?.resolve(confirmed);
      return null;
    });
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        onResult={onResult}
        title={pending?.options.title ?? ''}
        {...(pending?.options.description !== undefined && {
          description: pending.options.description,
        })}
        {...(pending?.options.confirmLabel !== undefined && {
          confirmLabel: pending.options.confirmLabel,
        })}
        {...(pending?.options.cancelLabel !== undefined && {
          cancelLabel: pending.options.cancelLabel,
        })}
        {...(pending?.options.danger !== undefined && { danger: pending.options.danger })}
        {...(pending?.options.requireText !== undefined && {
          requireText: pending.options.requireText,
        })}
      />
    </ConfirmContext.Provider>
  );
}

/** Ask for confirmation. */
export function useConfirm(): ConfirmFn {
  const value = useContext(ConfirmContext);
  if (value === null) throw new Error('useConfirm() requires ConfirmProvider');
  return value;
}
