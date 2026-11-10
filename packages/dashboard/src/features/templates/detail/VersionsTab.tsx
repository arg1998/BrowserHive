/** @module features/templates/detail/VersionsTab — the Versions tab (spec 13 §3.9, §3.12, §7.4, §11.4): the rolling checkpoint, then every version with why it was written, its size, per-domain cookie summary, per-site health, Last good and unreadable marks, Restore… and Pin; Save version now and Seed from file… ; a running restore or seed reports until it settles */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { useEffect, useRef, useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
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
import {
  useTemplateOperation,
  useTemplateOperations,
  useTemplateVersions,
} from '../api-operations.ts';
import { seedOverReadyConfirm } from '../confirm-copy.ts';
import { isRouteMissing } from '../pending/client.ts';
import type { TemplateVersionRow } from '../pending/contracts.ts';
import { HealthIcon } from '../SiteChips.tsx';
import { RestoreDialog } from './RestoreDialog.tsx';
import { reasonText, SEED_MAX_BYTES, summaryLines } from './version-text.ts';

type RestoreTarget = { readonly version: number | 'latest'; readonly label: string } | null;

function VersionRow({
  row,
  onRestore,
  onPin,
  pinning,
}: {
  readonly row: TemplateVersionRow;
  readonly onRestore: () => void;
  readonly onPin: () => void;
  readonly pinning: boolean;
}) {
  const Pin = row.pinned ? ICONS.unpin : ICONS.pin;
  const lines = summaryLines(row.summary);
  const restore = (
    <Button type="button" size="xs" variant="outline" disabled={!row.readable} onClick={onRestore}>
      <ICONS.restore aria-hidden="true" />
      Restore…
    </Button>
  );
  return (
    <li className="flex min-w-0 flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-semibold tabular-nums">Version {row.version}</span>
          <span className="text-muted-foreground">{reasonText(row)}</span>
          {row.last_good ? <Chip tone="success">Last good</Chip> : null}
          {row.pinned ? <Chip tone="info">Pinned</Chip> : null}
          {row.readable ? null : <Chip tone="danger">Unreadable with the current key</Chip>}
        </div>
        <p className="text-sm text-muted-foreground">
          <RelativeTime at={row.created_at} className="min-w-0 text-sm" /> ·{' '}
          {formatBytes(row.size_bytes)}
          {row.created_by !== null && row.created_by !== 'browserhive'
            ? ` · ${row.created_by}`
            : ''}
        </p>
        {lines.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-sm text-foreground/85">
            {lines.map((line) => (
              <li key={line} className="[overflow-wrap:anywhere]">
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        <ul aria-label="Sign-in health when written" className="flex flex-wrap gap-x-3 gap-y-1">
          {Object.entries(row.health).map(([site, state]) => (
            <li key={site} className="flex items-center gap-1 text-sm">
              <HealthIcon state={state} />
              <span>{site}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {row.readable ? (
          restore
        ) : (
          <Hint label="This version was written with another key">
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button cannot take focus, so its wrapper carries the tooltip reason */}
            <span tabIndex={0} className="rounded-md focus-ring">
              {restore}
            </span>
          </Hint>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pinning}
          aria-pressed={row.pinned}
          aria-label={row.pinned ? `Unpin version ${row.version}` : `Pin version ${row.version}`}
          onClick={onPin}
        >
          <Pin aria-hidden="true" />
          {row.pinned ? 'Unpin' : 'Pin'}
        </Button>
      </div>
    </li>
  );
}

/** Reports a restore or seed until it settles. */
function OperationProgress({
  operationId,
  onSettled,
}: {
  readonly operationId: string;
  readonly onSettled: () => void;
}) {
  const op = useTemplateOperation(operationId);
  const toast = useToast();
  const state = op.data?.state;
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || op.data === undefined || state === 'running') return;
    settled.current = true;
    const what = op.data.kind === 'restore' ? 'Restore' : 'Seeding';
    if (state === 'done') {
      toast.success({
        title: `${what} finished`,
        ...(op.data.version !== undefined && {
          description: `Version ${op.data.version} written.`,
        }),
      });
    } else {
      toast.error({ title: `${what} failed`, description: op.data.error?.message ?? '' });
    }
    onSettled();
  }, [op.data, state, toast, onSettled]);
  return (
    <Callout tone="info" title="Restarting the browser">
      <span className="inline-flex items-center gap-2">
        <Spinner /> Applying the sign-ins, then checking every site. Agents wait meanwhile.
      </span>
    </Callout>
  );
}

/** Versions tab. */
export function VersionsTab({ detail }: { readonly detail: TemplateDetailResponse }) {
  const { template, host } = detail;
  const id = template.template_id;
  const versions = useTemplateVersions(id);
  const ops = useTemplateOperations(id);
  const confirm = useConfirm();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<RestoreTarget>(null);
  const [operationId, setOperationId] = useState<string | null>(null);

  if (versions.isError && isRouteMissing(versions.error)) {
    return (
      <EmptyState
        kind="zero-data"
        variant="panel"
        icon="versions"
        title="Versions aren’t available on this server yet"
        description="This BrowserHive predates template versions. The browser’s profile still keeps every sign-in."
      />
    );
  }

  const running = host.state === 'running';
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
    if (picked.size > SEED_MAX_BYTES) {
      toast.error({ title: 'The file is larger than 16 MiB' });
      return;
    }
    let state: unknown;
    try {
      state = JSON.parse(await picked.text());
    } catch {
      toast.error({
        title: 'That file is not a storage state',
        description: 'Expected Playwright storage-state JSON.',
      });
      return;
    }
    const ready = template.status === 'ready';
    if (ready && !(await confirm(seedOverReadyConfirm(template.display_name)))) return;
    const started = await ops.seed.mutateAsync({ state, confirm: ready }).catch(() => null);
    if (started !== null) setOperationId(started.operation_id);
  };
  const onRestore = async (forceClose: boolean) => {
    if (target === null) return;
    const started = await ops.restore
      .mutateAsync({ version: target.version, forceClose })
      .catch(() => null);
    setTarget(null);
    if (started !== null) setOperationId(started.operation_id);
  };

  const save = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!running || ops.saveVersion.isPending}
      onClick={() => void onSave()}
    >
      {ops.saveVersion.isPending ? <Spinner /> : <ICONS.saveVersion aria-hidden="true" />}
      Save version now
    </Button>
  );
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
            {running ? (
              save
            ) : (
              <Hint label="Start the browser first">
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button cannot take focus, so its wrapper carries the tooltip reason */}
                <span tabIndex={0} className="rounded-md focus-ring">
                  {save}
                </span>
              </Hint>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={ops.seed.isPending}
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
            <li className="flex min-w-0 flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
                  disabled={!checkpoint.readable}
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
        onCancel={() => setTarget(null)}
        onRestore={(forceClose) => void onRestore(forceClose)}
      />
    </div>
  );
}
