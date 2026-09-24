/** @module features/sessions/activity/ActivityDetail — the expanded body of an Activity row: facts, error, where a call landed, parameters, result and screenshot for tool calls; the full record for pages, attention, vault fills and blocked requests; Copy JSON; a failed call's result is hidden when it only echoes the error */
import type { TimelineItem, ToolCallDetail } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { CopyButton, CopyValue } from '@/components/shared/CopyButton.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { JsonView } from '@/components/shared/JsonView.tsx';
import { StatusBadge, StatusDot } from '@/components/shared/StatusBadge.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatBytes } from '@/lib/format/bytes.ts';
import { formatAbsolute, formatMs } from '@/lib/format/time.ts';
import { cn } from '@/lib/utils.ts';
import { HarnessName } from '../../harness/HarnessName.tsx';
import { useToolCallDetailQuery } from '../api.ts';
import type { ActivityEntry } from './activity-model.ts';
import { ScreenshotThumb } from './ScreenshotThumb.tsx';

/** A labelled block inside the detail. */
function Block({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Inline facts row: `Duration 354 ms · Result 144 B · Tab t-abc`. */
function Facts({ items }: { readonly items: readonly (readonly [string, ReactNode] | null)[] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
      {items
        .filter((item): item is readonly [string, ReactNode] => item !== null)
        .map(([key, value]) => (
          <div key={key} className="flex min-w-0 items-baseline gap-2">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="min-w-0 text-foreground [overflow-wrap:break-word]">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Full URL as selectable mono text with copy. */
function FullUrl({ url }: { readonly url: string }) {
  return (
    <CopyValue
      value={url}
      label="Copy URL"
      display={<span className="font-mono text-sm break-all whitespace-normal">{url}</span>}
      className="items-start"
    />
  );
}

/** Error block (code + message, never repeated elsewhere in the detail). */
function ErrorBox({
  code,
  message,
}: {
  readonly code: string | null;
  readonly message: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5 text-danger-text">
      {code !== null ? <span className="font-mono text-sm font-semibold">{code}</span> : null}
      {message !== null && message !== '' ? (
        <p className="text-sm [overflow-wrap:break-word] whitespace-pre-wrap">{message}</p>
      ) : null}
    </div>
  );
}

/**
 * The result worth showing: a failed call's result is usually the error echoed back
 * (`[CODE] message`), already in the error box above, so it is dropped then.
 */
export function visibleResult(
  detail: Pick<ToolCallDetail, 'ok' | 'error_code' | 'error_message' | 'result_text'>,
): string | null {
  const text = detail.result_text;
  if (text === null || text === undefined || text.trim() === '') return null;
  const failed = !detail.ok || detail.error_code !== null;
  if (!failed) return text;
  const echoes = [detail.error_code, detail.error_message].some(
    (part) => part !== null && part !== '' && text.includes(part),
  );
  return echoes ? null : text;
}

function hasArgs(args: unknown): boolean {
  if (args === null || args === undefined) return false;
  if (typeof args === 'object') return Object.keys(args).length > 0;
  return true;
}

function ToolBody({
  sessionId,
  entry,
  detail,
}: {
  readonly sessionId: string;
  readonly entry: ActivityEntry & { readonly item: Extract<TimelineItem, { kind: 'tool' }> };
  readonly detail: ToolCallDetail;
}) {
  const api = useApi();
  const row = entry.item.row;
  const shot = detail.screenshot;
  const failed = !detail.ok || detail.error_code !== null;
  const result = visibleResult(detail);
  return (
    <>
      <Facts
        items={[
          [
            'Status',
            <StatusDot
              key="s"
              entry={
                failed ? { label: 'failed', tone: 'danger' } : { label: 'ok', tone: 'success' }
              }
            />,
          ],
          ['Duration', formatMs(detail.duration_ms)],
          ['Result', formatBytes(detail.result_size_bytes)],
          detail.tab_id !== null
            ? [
                'Tab',
                <span key="t" className="font-mono">
                  {detail.tab_id}
                </span>,
              ]
            : null,
          ['At', formatAbsolute(detail.ts)],
          detail.harness !== undefined
            ? ['Harness', <HarnessName key="h" harness={detail.harness} />]
            : null,
        ]}
      />
      {failed ? <ErrorBox code={detail.error_code} message={detail.error_message} /> : null}
      {entry.landed !== undefined ? (
        <Block label="Landed on">
          <FullUrl url={entry.landed.url} />
          {entry.landed.title !== null && entry.landed.title !== '' ? (
            <span className="text-sm text-muted-foreground">{entry.landed.title}</span>
          ) : null}
        </Block>
      ) : null}
      <div className="grid min-w-0 gap-4 @3xl:grid-cols-2">
        <Block label="Parameters">
          {hasArgs(detail.args_json) ? (
            <JsonView value={detail.args_json} collapseAt={3} />
          ) : (
            <p className="text-sm text-muted-foreground">No parameters.</p>
          )}
        </Block>
        {result !== null ? (
          <Block label="Result">
            <JsonView value={result} collapseAt={1} />
          </Block>
        ) : null}
      </div>
      {shot !== undefined || row.has_screenshot ? (
        <Block label="Screenshot">
          <ScreenshotThumb
            src={api.url('getScreenshotImage', {
              session_id: sessionId,
              event_id: shot?.event_id ?? row.event_id,
            })}
            tool={row.tool}
            ts={row.ts}
            width={shot?.width}
            height={shot?.height}
            sizeBytes={shot?.size_bytes}
            kind={shot?.kind}
            className="self-start"
          />
        </Block>
      ) : null}
    </>
  );
}

function ToolDetail({
  sessionId,
  entry,
}: {
  readonly sessionId: string;
  readonly entry: ActivityEntry & { readonly item: Extract<TimelineItem, { kind: 'tool' }> };
}) {
  const query = useToolCallDetailQuery(sessionId, entry.item.row.event_id, true);
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        tier="region"
        error={toAppError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return <ToolBody sessionId={sessionId} entry={entry} detail={query.data} />;
}

/** The record as JSON for "Copy JSON" (tool calls include the fetched parameters and result). */
function recordJson(entry: ActivityEntry, detail: unknown): string {
  return JSON.stringify(
    {
      kind: entry.item.kind,
      id: entry.id,
      ...(detail !== undefined ? { detail } : { row: entry.item.row }),
    },
    null,
    2,
  );
}

function OtherDetail({ entry }: { readonly entry: ActivityEntry }) {
  const { item } = entry;
  switch (item.kind) {
    case 'page':
      return (
        <>
          <Facts
            items={[
              ['Domain', item.row.domain],
              [
                'Tab',
                <span key="t" className="font-mono">
                  {item.row.tab_id}
                </span>,
              ],
              item.row.category !== 'public'
                ? [
                    'Category',
                    <StatusBadge
                      key="c"
                      domain="urlCategory"
                      value={item.row.category}
                      variant="pill"
                    />,
                  ]
                : null,
              ['At', formatAbsolute(item.ts)],
            ]}
          />
          <Block label="URL">
            <FullUrl url={item.row.url} />
          </Block>
        </>
      );
    case 'attention':
      return (
        <>
          <Facts
            items={[
              ['Status', <StatusBadge key="s" domain="request" value={item.row.status} />],
              ['Mode', item.row.mode ?? '—'],
              item.row.waited_ms !== null ? ['Waited', formatMs(item.row.waited_ms)] : null,
              item.row.resolved_by !== null ? ['By', item.row.resolved_by] : null,
              ['Requested', formatAbsolute(item.row.created_at)],
            ]}
          />
          <Block label="Reason">
            <p className="text-base [overflow-wrap:break-word] whitespace-pre-wrap">
              {item.row.reason}
            </p>
          </Block>
          {item.row.message !== null && item.row.message !== '' ? (
            <Block label="Operator message">
              <p className="text-base [overflow-wrap:break-word] whitespace-pre-wrap">
                {item.row.message}
              </p>
            </Block>
          ) : null}
          {item.row.page_url !== null ? (
            <Block label="Page">
              <FullUrl url={item.row.page_url} />
            </Block>
          ) : null}
          {item.row.options !== null ? (
            <Block label="Options">
              <JsonView value={item.row.options} />
            </Block>
          ) : null}
        </>
      );
    case 'vault':
      return (
        <>
          <Facts
            items={[
              ['Result', <StatusBadge key="r" domain="vaultResult" value={item.row.result} />],
              [
                'Entry',
                <span key="e" className="font-mono">
                  {item.row.entry_name}
                </span>,
              ],
              [
                'Origin check',
                <StatusBadge key="o" domain="originCheck" value={item.row.origin_check} />,
              ],
              ['Evaluate', item.row.evaluate_enabled ? 'permitted' : 'off'],
              ['At', formatAbsolute(item.ts)],
            ]}
          />
          {item.row.reason !== null ? (
            <Block label="Reason">
              <p className="text-base">{item.row.reason}</p>
            </Block>
          ) : null}
          <Block label="Page">
            <FullUrl url={item.row.page_url} />
          </Block>
        </>
      );
    case 'blocked':
      return (
        <>
          <Facts
            items={[
              [
                'Pattern',
                <span key="p" className="font-mono">
                  {item.row.pattern}
                </span>,
              ],
              ['Source', <StatusBadge key="s" domain="blockedSource" value={item.row.source} />],
              item.row.tool !== null
                ? [
                    'During',
                    <span key="t" className="font-mono">
                      {item.row.tool}
                    </span>,
                  ]
                : null,
              ['At', formatAbsolute(item.ts)],
            ]}
          />
          <Block label="URL">
            <FullUrl url={item.row.url} />
          </Block>
        </>
      );
    default:
      return null;
  }
}

/** Expanded row body. */
export function ActivityDetail({
  sessionId,
  entry,
  className,
}: {
  readonly sessionId: string;
  readonly entry: ActivityEntry;
  readonly className?: string;
}) {
  const detail = useToolCallDetailQuery(
    sessionId,
    entry.item.kind === 'tool' ? entry.item.row.event_id : '',
    false,
  ).data;
  return (
    <div className={cn('@container relative flex min-w-0 flex-col gap-4', className)}>
      <div className="absolute top-0 right-0">
        <CopyButton
          value={recordJson(entry, detail)}
          label="Copy as JSON"
          visibility="always"
          size="icon-sm"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4 pr-10">
        {entry.item.kind === 'tool' ? (
          <ToolDetail
            sessionId={sessionId}
            entry={
              entry as ActivityEntry & { readonly item: Extract<TimelineItem, { kind: 'tool' }> }
            }
          />
        ) : (
          <OtherDetail entry={entry} />
        )}
      </div>
    </div>
  );
}
