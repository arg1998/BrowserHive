/** @module components/shared/ConfirmDialog — AlertDialog with focus trap/restore, danger tone and typed confirmation (spec 04 §7, §11) */
import { type FormEvent, useId, useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';

/** Confirmation request. */
export interface ConfirmOptions {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Destructive styling on the confirm button. */
  readonly danger?: boolean;
  /** The operator must type this text exactly (e.g. the session slug). */
  readonly requireText?: string;
}

/** Props. */
export interface ConfirmDialogProps extends ConfirmOptions {
  readonly open: boolean;
  readonly onResult: (confirmed: boolean) => void;
}

/** Controlled confirmation dialog. */
export function ConfirmDialog({
  open,
  onResult,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  requireText,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const satisfied = requireText === undefined || typed === requireText;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!satisfied) return;
    setTyped('');
    onResult(true);
  };
  const cancel = () => {
    setTyped('');
    onResult(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : cancel())}>
      <AlertDialogContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description !== undefined ? (
              <AlertDialogDescription>{description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          {requireText !== undefined ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={inputId}>
                Type <span className="font-mono">{requireText}</span> to confirm
              </Label>
              <Input
                id={inputId}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={cancel}>
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={danger ? 'destructive-solid' : 'default'}
              disabled={!satisfied}
            >
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
