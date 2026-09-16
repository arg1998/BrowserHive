/** @module features/sessions/list/BulkResultDialog — per-item result table after a bulk action (ok / failed with code); never a single "done" (spec 04 §5) */
import type { BulkSessionAction, BulkSessionsResponse } from '@browserhive/contracts/http';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { SessionRef } from '@/components/shared/session-ref.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';

/** Props. */
export interface BulkResultDialogProps {
  readonly result: {
    readonly action: BulkSessionAction;
    readonly response: BulkSessionsResponse;
  } | null;
  readonly onClose: () => void;
}

const VERB: { readonly [K in BulkSessionAction]: string } = {
  archive: 'Archived',
  unarchive: 'Unarchived',
  terminate: 'Terminated',
  delete: 'Deleted',
};

/** Result dialog. */
export function BulkResultDialog({ result, onClose }: BulkResultDialogProps) {
  const open = result !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {result !== null ? `${VERB[result.action]} sessions` : 'Bulk result'}
          </DialogTitle>
          <DialogDescription>
            {result !== null
              ? `${formatNumber(result.response.ok_count)} ok · ${formatNumber(result.response.error_count)} failed`
              : ''}
          </DialogDescription>
        </DialogHeader>
        {result !== null ? (
          <div className="max-h-80 overflow-auto rounded-md border" data-scroll-region="">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.response.results.map((item) => (
                  <TableRow key={item.session_id}>
                    <TableCell>
                      <SessionRef id={item.session_id} />
                    </TableCell>
                    <TableCell>
                      {item.ok ? (
                        <TonePill entry={{ label: 'ok', tone: 'success' }} />
                      ) : (
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <TonePill entry={{ label: 'failed', tone: 'danger' }} />
                          {item.error !== undefined ? (
                            <span className="text-xs text-muted-foreground">
                              <span className="font-mono">{item.error.code}</span> ·{' '}
                              {item.error.title}
                            </span>
                          ) : null}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
