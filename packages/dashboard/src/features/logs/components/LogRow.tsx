/** @module features/logs/components/LogRow — one log record: a whole-row toggle (time, level, module, message with an HTTP summary and priority fields, 13px mono) and the expanded detail (actions, full message, correlation ids, error, fields JSON) */
import type { LogRecord } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { memo, useState } from 'react';
import { CopyButton, copyText } from '@/components/shared/CopyButton.tsx';
import { JsonView } from '@/components/shared/JsonView.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { formatAbsolute } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import {
  correlation,
  extraFields,
  httpSummary,
  inlineFields,
  levelEntry,
  traceUrl,
} from '../log-fields.ts';

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});

/** `14:05:22.123`. */
export function formatLogTime(ts: number): string {
  return clock.format(new Date(ts));
}

/** Grid shared by the column header and every row (≥640px). */
export const LOG_GRID =
  'sm:grid sm:grid-cols-[1rem_6.25rem_3.25rem_minmax(0,8rem)_minmax(0,1fr)] lg:grid-cols-[1rem_6.25rem_3.25rem_minmax(0,11rem)_minmax(0,1fr)] sm:items-center sm:gap-x-3';

function statusTone(status: number): string {
  if (status >= 500) return TONE_CLASSES.danger.text;
  if (status >= 400) return TONE_CLASSES.warn.text;
  return 'text-muted-foreground';
}

/** Message cell: HTTP summary or message, then priority `key=value` fields. */
function Message({ record }: { readonly record: LogRecord }) {
  const http = httpSummary(record);
  const fields = inlineFields(record, 3);
  return (
    <span className="block min-w-0 truncate">
      {http !== null ? (
        <>
          <span className="text-foreground">
            {http.method} {http.target}
          </span>
          {http.status !== null ? (
            <span className={cn('ml-2', statusTone(http.status))}>{http.status}</span>
          ) : null}
          {http.durationMs !== null ? (
            <span className="ml-2 text-muted-foreground">{http.durationMs} ms</span>
          ) : null}
          {record.msg !== 'request completed' ? (
            <span className="ml-2 text-muted-foreground">{record.msg}</span>
          ) : null}
        </>
      ) : (
        <span className="text-foreground">{record.msg}</span>
      )}
      {fields.map((field) => (
        <span key={field.key} className="ml-3 text-muted-foreground">
          {field.key}=<span className="text-foreground/80">{field.value}</span>
        </span>
      ))}
    </span>
  );
}

/** Props. */
export interface LogRowProps {
  readonly record: LogRecord;
  readonly expanded: boolean;
  readonly onToggle: (seq: number) => void;
  /** `otelTraceUrlTemplate` from the system config, when telemetry is on. */
  readonly traceTemplate?: string | undefined;
}

/** One record. Memoised: a busy tail re-renders the list, not every row. */
export const LogRow = memo(function LogRow({
  record,
  expanded,
  onToggle,
  traceTemplate,
}: LogRowProps) {
  const level = levelEntry(record.level);
  const tone = TONE_CLASSES[level.tone];
  const Chevron = ICONS.chevronRight;
  return (
    <div
      data-level={record.level}
      className={cn(
        'border-b border-border/70 font-mono text-sm',
        record.level === 'error' && 'bg-danger-bg/35',
        record.level === 'warn' && 'bg-warn-bg/35',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(record.seq)}
        className={cn(
          'group/log relative flex w-full cursor-pointer flex-col gap-0.5 px-4 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:min-h-8 sm:py-1',
          LOG_GRID,
          expanded && 'bg-accent',
        )}
      >
        {record.level === 'error' || record.level === 'warn' ? (
          <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-0.5', tone.dot)} />
        ) : null}
        <span className="flex min-w-0 items-center gap-3 sm:contents">
          <Chevron
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 text-subtle-foreground transition-transform duration-(--duration-fast) group-hover/log:text-muted-foreground',
              expanded && 'rotate-90',
            )}
          />
          <time
            dateTime={new Date(record.ts).toISOString()}
            className="shrink-0 text-muted-foreground tabular-nums"
          >
            {formatLogTime(record.ts)}
          </time>
          <span
            className={cn(
              'shrink-0',
              record.level === 'info' || record.level === 'debug' || record.level === 'trace'
                ? 'text-muted-foreground'
                : tone.text,
            )}
          >
            {level.label}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">{record.module}</span>
        </span>
        <span className="min-w-0 pl-7 sm:pl-0">
          <Message record={record} />
        </span>
      </button>
      {expanded ? <LogDetail record={record} traceTemplate={traceTemplate} /> : null}
    </div>
  );
});

function DetailActions({
  record,
  traceTemplate,
}: {
  readonly record: LogRecord;
  readonly traceTemplate: string | undefined;
}) {
  const apm = traceUrl(traceTemplate, record.trace_id);
  const External = ICONS.external;
  const Filter = ICONS.filter;
  const small = buttonVariants({ variant: 'outline', size: 'xs' });
  return (
    <div className="flex flex-wrap items-center gap-2 font-sans">
      <CopyJson record={record} />
      {record.trace_id !== undefined ? (
        <Link to="/logs" search={{ trace_id: record.trace_id }} className={small}>
          <Filter aria-hidden="true" />
          Filter to trace
        </Link>
      ) : null}
      {record.request_id !== undefined ? (
        <Link to="/logs" search={{ request_id: record.request_id }} className={small}>
          <Filter aria-hidden="true" />
          Filter to request
        </Link>
      ) : null}
      {record.session_id !== undefined ? (
        <Link
          to="/sessions/$id"
          params={{ id: record.session_id }}
          className={small}
          aria-label={`Open session ${record.session_id}`}
        >
          <ICONS.sessions aria-hidden="true" />
          Open session
        </Link>
      ) : null}
      {apm !== null ? (
        <a href={apm} target="_blank" rel="noreferrer" className={small}>
          <External aria-hidden="true" />
          Open trace in APM
        </a>
      ) : null}
    </div>
  );
}

function CopyJson({ record }: { readonly record: LogRecord }) {
  const [copied, setCopied] = useState(false);
  const Icon = copied ? ICONS.check : ICONS.copy;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => {
        void copyText(JSON.stringify(record, null, 2)).then((ok) => {
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon aria-hidden="true" />
      {copied ? 'Copied' : 'Copy JSON'}
    </Button>
  );
}

/** Expanded record detail. */
export function LogDetail({
  record,
  traceTemplate,
}: {
  readonly record: LogRecord;
  readonly traceTemplate: string | undefined;
}) {
  const fields = extraFields(record);
  const ids = correlation(record);
  const hasFields = Object.keys(fields).length > 0;
  return (
    <div className="flex flex-col gap-3 border-t border-border/70 bg-muted/60 px-4 py-3 sm:pl-11 dark:bg-white/[0.025]">
      <DetailActions record={record} traceTemplate={traceTemplate} />
      <p className="text-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">{record.msg}</p>
      <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] items-center gap-x-4">
        <dt className="font-sans text-muted-foreground">Time</dt>
        <dd className="flex min-h-7 items-center [overflow-wrap:anywhere]">
          {formatAbsolute(record.ts)} · {new Date(record.ts).toISOString()}
        </dd>
        <dt className="font-sans text-muted-foreground">Module</dt>
        <dd className="flex min-h-7 items-center [overflow-wrap:anywhere]">{record.module}</dd>
        <dt className="font-sans text-muted-foreground">Sequence</dt>
        <dd className="flex min-h-7 items-center tabular-nums">{record.seq}</dd>
        {ids.map(([key, value]) => (
          <div key={key} className="contents" data-reveal-scope="">
            <dt className="font-sans text-muted-foreground">{key}</dt>
            <dd className="flex min-h-7 min-w-0 items-center gap-1">
              <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
              <CopyButton value={value} label={`Copy ${key}`} />
            </dd>
          </div>
        ))}
      </dl>
      {record.err !== undefined ? (
        <pre className="rounded-lg bg-danger-bg px-3 py-2 [overflow-wrap:anywhere] whitespace-pre-wrap text-danger-text">
          {record.err.name}: {record.err.message}
          {record.err.code !== undefined ? ` (${record.err.code})` : ''}
          {record.err.stack !== undefined ? `\n${record.err.stack}` : ''}
        </pre>
      ) : null}
      {hasFields ? (
        <JsonView value={fields} collapseAt={2} className="rounded-lg bg-card px-3 py-2" />
      ) : null}
    </div>
  );
}
