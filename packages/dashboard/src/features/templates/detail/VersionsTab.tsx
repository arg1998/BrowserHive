/** @module features/templates/detail/VersionsTab — the Versions tab (spec 13 §3.9, §3.12, §7.4, §11.4): the rolling checkpoint, then every version (`VersionRow`), Restore… (closing or waiting for live sessions, refusals explained), Pin, Save version now and Seed from file…; a running restore or seed reports until it settles */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { useRef, useState } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatBytes } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useTemplateOperations, useTemplateVersions } from '../api-operations.ts';
import { OperationProgress } from './OperationProgress.tsx';
import { RestoreDialog } from './RestoreDialog.tsx';
import { useSeedFromFile } from './use-seed.ts';
import { VersionRow } from './VersionRow.tsx';
import { operationRefusal } from './version-text.ts';

type RestoreTarget = { readonly version: number | 'latest'; readonly label: string } | null;

/** A disabled button with its reason in a tooltip (a disabled button cannot take focus). */
function WithReason({
  reason,
  children,
}: {
  readonly reason: string | null;
  readonly children: React.ReactElement;
}) {
  if (reason === null) return children;
  return (
    <Hint label={reason}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the wrapper carries the disabled button's reason */}
      <span tabIndex={0} className="rounded-md focus-ring">
        {children}
      </span>
    </Hint>
  );
}

/** Versions tab. */
export function VersionsTab({ detail }: { readonly detail: TemplateDetailResponse }) {
  const { template, host } = detail;
  const id = template.template_id;
  const versions = useTemplateVersions(id);
  const ops = useTemplateOperations(id);
  const seeding = useSeedFromFile(template);
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<RestoreTarget>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const running = host.state === 'running';
  const busy = operationId !== null;

  const onSave = async () => {
    const result = await ops.saveVersion.mutateAsync().catch(() => null);
    if (result === null) return;
    toast.success({
      title:
        result.version === null
          ? 'Nothing changed since the newest version'
          : `Version ${result.version} saved`,
    });
  };
  const onSeedFile = async (picked: File | undefined) => {
    if (file.current !== null) file.current.value = '';
    if (picked === undefined) return;
    const started = await seeding.seed(picked);
    if (started !== null) setOperationId(started);
  };
  const onRestore = async (forceClose: boolean) => {
    if (target === null) return;
    setRestoreError(null);
    try {
      const started = await ops.restore.mutateAsync({ version: target.version, forceClose });
      setTarget(null);
      setOperationId(started.operation_id);
    } catch (error) {
      setRestoreError(operationRefusal(toAppError(error), 'restore'));
    }
  };

  const checkpoint = versions.data?.checkpoint ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {operationId !== null ? (
        <OperationProgress operationId={operationId} onSettled={() => setOperationId(null)} />
      ) : null}
      <Panel
        title="Versions"
        description="Encrypted snapshots of the sign-ins, written at milestones. Restoring one never changes it."
        padding="none"
        actions={
          <>
            <WithReason reason={running ? null : 'Start the browser first'}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!running || busy || ops.saveVersion.isPending}
                onClick={() => void onSave()}
              >
                {ops.saveVersion.isPending ? <Spinner /> : <ICONS.saveVersion aria-hidden="true" />}
                Save version now
              </Button>
            </WithReason>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || seeding.pending}
              onClick={() => file.current?.click()}
            >
              <ICONS.seed aria-hidden="true" />
              Seed from file…
            </Button>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              tabIndex={-1}
              aria-label="Storage-state file"
              onChange={(event) => void onSeedFile(event.target.files?.[0])}
            />
          </>
        }
      >
        {versions.isPending ? (
          <SkeletonCard className="m-5" />
        ) : versions.isError ? (
          <ErrorState
            tier="region"
            error={toAppError(versions.error)}
            onRetry={() => void versions.refetch()}
          />
        ) : (
          <ul aria-label="Versions" className="flex flex-col divide-y">
            <li className="flex min-w-0 flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="flex max-w-3xl min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-semibold">Rolling checkpoint</span>
                <span className="text-sm text-muted-foreground">
                  {checkpoint === null ? (
                    'Written every 15 minutes while the browser runs; none yet.'
                  ) : (
                    <>
                      Every 15 minutes while the browser runs · last{' '}
                      <RelativeTime at={checkpoint.at} className="min-w-0 text-sm" /> ·{' '}
                      {formatBytes(checkpoint.size_bytes)}
                    </>
                  )}
                </span>
              </div>
              {checkpoint !== null ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!checkpoint.readable || busy}
                  onClick={() => setTarget({ version: 'latest', label: 'the checkpoint' })}
                >
                  <ICONS.restore aria-hidden="true" />
                  Restore…
                </Button>
              ) : null}
            </li>
            {versions.data.data.length === 0 ? (
              <li className="px-5 py-6 text-center text-sm text-muted-foreground">
                No versions yet. The first one is written when the sign-in finishes.
              </li>
            ) : (
              versions.data.data.map((row) => (
                <VersionRow
                  key={row.version}
                  row={row}
                  pinning={ops.pinVersion.isPending}
                  onRestore={() =>
                    setTarget({ version: row.version, label: `version ${row.version}` })
                  }
                  onPin={() => ops.pinVersion.mutate({ version: row.version, pinned: !row.pinned })}
                />
              ))
            )}
          </ul>
        )}
      </Panel>
      <RestoreDialog
        templateId={id}
        target={target}
        busy={ops.restore.isPending}
        error={restoreError}
        onCancel={() => {
          setTarget(null);
          setRestoreError(null);
        }}
        onRestore={(forceClose) => void onRestore(forceClose)}
      />
    </div>
  );
}
