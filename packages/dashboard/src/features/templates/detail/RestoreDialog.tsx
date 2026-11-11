/** @module features/templates/detail/RestoreDialog — Restore… (spec 13 §3.12, §11.4): what restoring does, the live sessions it affects, and whether to close them now or wait for them to finish before the browser restarts */
import { useEffect, useRef, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { restoreConfirm } from '../confirm-copy.ts';
import { useLiveSessionLines } from '../use-template-actions.ts';

/** Props. */
export interface RestoreDialogProps {
  readonly templateId: string;
  /** `null` = closed; otherwise what to restore and how to call it. */
  readonly target: { readonly version: number | 'latest'; readonly label: string } | null;
  readonly busy: boolean;
  /** Why the server refused the restore, shown above the buttons. */
  readonly error?: string | null;
  readonly onCancel: () => void;
  readonly onRestore: (forceClose: boolean) => void;
}

/** Restore dialog. */
export function RestoreDialog({
  templateId,
  target,
  busy,
  error = null,
  onCancel,
  onRestore,
}: RestoreDialogProps) {
  const liveLines = useRef(useLiveSessionLines());
  const [sessions, setSessions] = useState<readonly string[] | null>(null);
  const [mode, setMode] = useState<'close' | 'wait'>('wait');
  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    setSessions(null);
    setMode('wait');
    void liveLines.current(templateId).then((lines) => {
      if (!cancelled) setSessions(lines);
    });
    return () => {
      cancelled = true;
    };
  }, [target, templateId]);
  const copy = restoreConfirm(target?.label ?? '', sessions ?? []);
  const count = sessions?.length ?? 0;
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-1">
          {sessions === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Checking for live sessions…
            </p>
          ) : count === 0 ? (
            <p className="text-sm text-muted-foreground">No session is using the browser now.</p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">
                  {count} live {count === 1 ? 'session' : 'sessions'}
                </p>
                <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-lg bg-muted px-3 py-2">
                  {sessions.map((line) => (
                    <li key={line} className="truncate font-mono text-sm">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-col gap-1.5">
                <span id="restore-mode" className="text-sm font-medium">
                  Before the browser restarts
                </span>
                <ToggleGroup
                  aria-labelledby="restore-mode"
                  size="sm"
                  spacing={0}
                  value={[mode]}
                  onValueChange={(value: readonly string[]) => {
                    const next = value[0];
                    if (next === 'close' || next === 'wait') setMode(next);
                  }}
                >
                  <ToggleGroupItem value="wait">Wait for sessions</ToggleGroupItem>
                  <ToggleGroupItem value="close">Close sessions now</ToggleGroupItem>
                </ToggleGroup>
                <p className="text-sm text-muted-foreground">
                  {mode === 'wait'
                    ? 'New launches wait; the browser restarts once these sessions end, or after 15 minutes.'
                    : 'Their agents lose their pages now.'}
                </p>
              </div>
            </>
          )}
          {error !== null ? (
            <Callout tone="danger" title="The restore didn’t start">
              {error}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={mode === 'close' && count > 0 ? 'destructive-solid' : 'default'}
            disabled={busy || sessions === null}
            onClick={() => onRestore(mode === 'close' && count > 0)}
          >
            {busy ? <Spinner /> : null}
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
