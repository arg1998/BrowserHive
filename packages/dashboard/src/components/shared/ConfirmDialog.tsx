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
  /** What the action affects, one line each (the live sessions it closes); shown as a list. */
  readonly items?: readonly string[];
  /** Heading of `items` ("Sessions that close"). */
  readonly itemsLabel?: string;
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
  items,
  itemsLabel,
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
          {items !== undefined && items.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {itemsLabel !== undefined ? (
                <p className="text-sm font-medium text-foreground">{itemsLabel}</p>
              ) : null}
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg bg-muted px-3 py-2 dark:bg-white/[0.04]">
                {items.map((item) => (
                  <li key={item} className="truncate font-mono text-sm text-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
