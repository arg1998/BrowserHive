/** @module features/templates/detail/OperationProgress — a running restore or seed (spec 13 §3.12, §7.4): what is happening while agents wait, then a toast with the version written and the sessions it closed, or why it failed */
import { useEffect, useRef } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { useTemplateOperation } from '../api-operations.ts';

/** Progress of one operation; `onSettled` once it is done or failed. */
export function OperationProgress({
  operationId,
  onSettled,
}: {
  readonly operationId: string;
  readonly onSettled: () => void;
}) {
  const op = useTemplateOperation(operationId);
  const toast = useToast();
  const settled = useRef(false);
  const data = op.data;
  useEffect(() => {
    if (settled.current || data === undefined || data.state === 'running') return;
    settled.current = true;
    const what = data.kind === 'restore' ? 'Restore' : 'Seeding';
    const closed = data.closed_sessions.length;
    if (data.state === 'done') {
      toast.success({
        title: `${what} finished`,
        description: [
          data.version !== undefined ? `Version ${data.version} written.` : null,
          closed > 0 ? `${closed} session${closed === 1 ? '' : 's'} closed.` : null,
          'Every site is being checked.',
        ]
          .filter((s) => s !== null)
          .join(' '),
      });
    } else {
      toast.error({
        title: `${what} failed`,
        description: data.error?.message ?? 'The browser kept its previous sign-ins.',
      });
    }
    onSettled();
  }, [data, toast, onSettled]);
  return (
    <Callout
      tone="info"
      title={data?.kind === 'seed' ? 'Seeding the sign-ins' : 'Restoring the sign-ins'}
    >
      <span className="inline-flex items-center gap-2" role="status">
        <Spinner /> The browser restarts with them, then every site is checked. Agents wait
        meanwhile.
      </span>
    </Callout>
  );
}
