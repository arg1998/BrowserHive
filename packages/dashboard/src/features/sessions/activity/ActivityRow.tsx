/** @module features/sessions/activity/ActivityRow — one Activity event. List anatomy, the same at every width: time on the left · kind/tool icon · primary (+ outcome) over a secondary line (errors and reasons wrap to two lines, URLs truncate) · screenshot and duration when there is room · chevron. Table anatomy: time · event · details (full error code first) · status icon for problems only · duration · size. The whole row toggles its inline detail; the chevron is the keyboard stop (j/k move between rows) */
import type { KeyboardEvent, MouseEvent } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { Breakable } from '@/components/shared/breakable.tsx';
import { isRowClick } from '@/components/shared/DataTableBody.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { splitUrl } from '@/components/shared/url-cell.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatAbsolute } from '@/lib/format/time.ts';
import { stripCredentials } from '@/lib/format/urls.ts';
import { ICONS, type IconName } from '@/lib/icons.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import type { ActivityView } from '../detail-search.ts';
import { ActivityDetail } from './ActivityDetail.tsx';
import {
  type ActivityDescription,
  type ActivityEntry,
  describeEntry,
  eventTime,
} from './activity-model.ts';
import { ScreenshotThumb } from './ScreenshotThumb.tsx';

/** Props. */
export interface ActivityRowProps {
  readonly sessionId: string;
  readonly entry: ActivityEntry;
  readonly now: number;
  readonly view: ActivityView;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
  /** Roving focus: the one row whose toggle is in the tab order. */
  readonly tabbable?: boolean;
  readonly onFocusRow?: () => void;
  readonly onRowKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** Column widths shared by the table header and table rows. */
export const TABLE_COLUMNS = {
  time: 'w-[4.75rem]',
  event: 'w-44 @3xl:w-52',
  status: 'w-6',
  duration: 'w-16 text-right',
  size: 'hidden w-16 text-right @3xl:block',
  chevron: 'w-4',
} as const;

/** Where the expanded detail starts in list rows: under the text column (px-4 + time + gap + icon + gap). */
const LIST_DETAIL_INDENT = '@2xl:pl-[8.5rem]';
const TABLE_DETAIL_INDENT = '@2xl:pl-[7.75rem]';

/** Status icon by tone (table view): only problems and outcomes get one. */
const STATUS_ICON: { readonly [K in Tone]?: IconName } = {
  danger: 'error',
  warn: 'clock',
  success: 'success',
  neutral: 'minus',
};

/** Event time: `HH:MM:SS` (+ date when not today), full timestamp in a tooltip. */
function EventTime({
  ts,
  now,
  className,
}: {
  readonly ts: number;
  readonly now: number;
  readonly className?: string;
}) {
  const time = eventTime(ts, now);
  return (
    <Hint label={formatAbsolute(ts)}>
      <time
        dateTime={new Date(ts).toISOString()}
        className={cn(
          'flex shrink-0 flex-col font-mono text-sm leading-5 text-muted-foreground tabular-nums',
          className,
        )}
      >
        <span>{time.clock}</span>
        {time.date !== undefined ? (
          <span className="font-sans text-xs leading-4">{time.date}</span>
        ) : null}
      </time>
    </Hint>
  );
}

/** Kind icon on a soft tile. */
function KindIcon({
  description,
  size = 'md',
}: {
  readonly description: ActivityDescription;
  readonly size?: 'sm' | 'md';
}) {
  const Icon = ICONS[description.icon];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md',
        size === 'md' ? 'size-7' : 'size-5 rounded-sm',
        description.tone === 'neutral'
          ? 'bg-muted text-muted-foreground dark:bg-white/[0.06]'
          : TONE_CLASSES[description.tone].soft,
      )}
    >
      <Icon className={size === 'md' ? 'size-4' : 'size-3.5'} />
    </span>
  );
}

/** Second line: host + path for URLs (never a tooltip trigger: the row is the click target). */
function Secondary({
  description,
  view,
}: {
  readonly description: ActivityDescription;
  readonly view: ActivityView;
}) {
  const secondary = description.secondary;
  if (secondary === undefined) return null;
  const clamp = view === 'table' ? 'truncate' : 'line-clamp-2 [overflow-wrap:break-word]';
  if (secondary.type === 'error') {
    // Long codes (ELEMENT_NOT_ACTIONABLE) wrap at `_` on narrow rows, never mid-word.
    return (
      <span className={cn('block min-w-0 text-sm text-danger-text', clamp)}>
        {secondary.code !== null ? <Breakable>{secondary.code}</Breakable> : null}
        {secondary.code !== null && secondary.message !== null ? ' · ' : null}
        {secondary.message}
      </span>
    );
  }
  if (secondary.type === 'text') {
    return (
      <span
        className={cn(
          'block min-w-0 text-sm',
          clamp,
          secondary.tone === 'danger' ? 'text-danger-text' : 'text-muted-foreground',
        )}
      >
        {secondary.text}
      </span>
    );
  }
  const { host, rest } = splitUrl(stripCredentials(secondary.url));
  return (
    <span className="flex min-w-0 items-baseline gap-2 text-sm">
      <span className="min-w-0 truncate font-mono">
        <span className="text-foreground/80">{host}</span>
        <span className="text-muted-foreground">{rest}</span>
      </span>
      {secondary.note !== undefined ? (
        <span
          className={cn(
            'hidden max-w-[40%] shrink truncate text-muted-foreground',
            view === 'table' ? '@5xl:inline' : '@xl:inline',
          )}
        >
          {secondary.note}
        </span>
      ) : null}
    </span>
  );
}

/** Table status: blank when all is well, an icon (label in the tooltip and for screen readers) otherwise. */
function StatusIcon({ status }: { readonly status: ActivityDescription['status'] }) {
  if (status.label === '') return <span className={TABLE_COLUMNS.status} />;
  const Icon = ICONS[STATUS_ICON[status.tone] ?? 'info'];
  return (
    <span className={cn('flex shrink-0 justify-center', TABLE_COLUMNS.status)}>
      <Hint label={status.label}>
        <span role="img" aria-label={status.label} className={TONE_CLASSES[status.tone].text}>
          <Icon aria-hidden="true" className="size-4" />
        </span>
      </Hint>
    </span>
  );
}

/** One row. */
export function ActivityRow({
  sessionId,
  entry,
  now,
  view,
  expanded,
  onToggle,
  tabbable = true,
  onFocusRow,
  onRowKeyDown,
}: ActivityRowProps) {
  const api = useApi();
  const description = describeEntry(entry);
  const Chevron = ICONS.chevronRight;
  const label = `${description.kindLabel}: ${description.primary}${expanded ? ' (expanded)' : ''}`;
  const shotSrc =
    description.hasScreenshot && entry.item.kind === 'tool'
      ? api.url('getScreenshotImage', { session_id: sessionId, event_id: entry.item.row.event_id })
      : null;
  const chevron = (
    <button
      type="button"
      data-row-toggle=""
      aria-expanded={expanded}
      aria-label={label}
      tabIndex={tabbable ? 0 : -1}
      className="relative -mr-1.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground [outline-style:none] after:absolute after:-inset-1.5 hover:bg-accent hover:text-foreground"
      onClick={() => onToggle(entry.id)}
      onFocus={onFocusRow}
      onKeyDown={onRowKeyDown}
    >
      <Chevron
        aria-hidden="true"
        className={cn(
          'size-4 transition-transform duration-(--duration-fast)',
          expanded && 'rotate-90 text-foreground',
        )}
      />
    </button>
  );
  const onHeadClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isRowClick(event)) onToggle(entry.id);
  };
  const primary = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span
        className={cn(
          'min-w-0 truncate text-foreground',
          description.primaryMono ? 'font-mono text-sm font-medium' : 'text-base font-medium',
        )}
      >
        {description.primary}
      </span>
      {description.badge !== undefined && view === 'list' ? (
        <span
          className={cn('shrink-0 text-sm font-medium', TONE_CLASSES[description.badge.tone].text)}
        >
          {description.badge.label}
        </span>
      ) : null}
    </span>
  );

  const head =
    view === 'table' ? (
      // biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; the chevron button is the keyboard control
      // biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button handles the keyboard
      <div
        className="flex h-10 min-w-0 cursor-pointer items-center gap-3 px-4"
        onClick={onHeadClick}
      >
        <EventTime
          ts={entry.item.ts}
          now={now}
          className={cn(TABLE_COLUMNS.time, '[&>span+span]:hidden')}
        />
        <span className={cn('flex min-w-0 shrink-0 items-center gap-2', TABLE_COLUMNS.event)}>
          <KindIcon description={description} size="sm" />
          {primary}
        </span>
        <span className="min-w-0 flex-1">
          <Secondary description={description} view={view} />
        </span>
        <StatusIcon status={description.status} />
        <span
          className={cn(
            'shrink-0 text-sm text-muted-foreground tabular-nums',
            TABLE_COLUMNS.duration,
          )}
        >
          {description.duration ?? ''}
        </span>
        <span
          className={cn('shrink-0 text-sm text-muted-foreground tabular-nums', TABLE_COLUMNS.size)}
        >
          {description.size ?? ''}
        </span>
        {chevron}
      </div>
    ) : (
      // biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; the chevron button is the keyboard control
      // biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button handles the keyboard
      <div
        className="flex min-h-14 min-w-0 cursor-pointer items-center gap-2.5 px-4 py-2 @md:gap-3"
        onClick={onHeadClick}
      >
        <EventTime ts={entry.item.ts} now={now} className="w-[4.25rem]" />
        <KindIcon description={description} />
        <span className="flex min-w-0 flex-1 flex-col">
          {primary}
          {expanded && description.secondary?.type === 'error' ? null : (
            <Secondary description={description} view={view} />
          )}
        </span>
        {shotSrc !== null && entry.item.kind === 'tool' ? (
          <ScreenshotThumb
            variant="row"
            src={shotSrc}
            tool={entry.item.row.tool}
            ts={entry.item.ts}
            className="hidden @xl:block"
          />
        ) : null}
        <span className="hidden w-16 shrink-0 text-right text-sm text-muted-foreground tabular-nums @lg:block">
          {description.duration ?? null}
        </span>
        {chevron}
      </div>
    );

  return (
    <div
      data-activity-row=""
      data-kind={entry.item.kind}
      data-expanded={expanded ? '' : undefined}
      className={cn(
        'group/row relative border-b transition-colors duration-(--duration-fast)',
        'has-[[data-row-toggle]:focus-visible]:[outline:var(--ring-width)_solid_var(--ring)] has-[[data-row-toggle]:focus-visible]:[outline-offset:calc(var(--ring-width)*-1)]',
        expanded
          ? 'bg-accent/40 dark:bg-white/[0.025]'
          : 'hover:bg-accent/60 dark:hover:bg-white/[0.03]',
      )}
    >
      {head}
      {expanded ? (
        <ActivityDetail
          sessionId={sessionId}
          entry={entry}
          className={cn(
            'pr-4 pb-4 pl-4',
            view === 'table' ? `${TABLE_DETAIL_INDENT} pt-1` : `${LIST_DETAIL_INDENT} pt-0.5`,
          )}
        />
      ) : null}
    </div>
  );
}
