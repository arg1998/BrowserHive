/** @module components/shared/date-range-picker — custom window popover: ISO from/to fields with optional time, a keyboard-navigable month grid for picking the range, writing an epoch-ms `since`/`until` window (spec 04 §7) */
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { browserClock } from '@/lib/clock.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** A custom window (epoch ms, half-open). */
export interface DateRange {
  readonly since?: number | undefined;
  readonly until?: number | undefined;
}

/** Props. */
export interface DateRangePickerProps {
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  /** `null` clears the custom window. */
  readonly onChange: (next: DateRange | null) => void;
  readonly className?: string;
}

/** A local calendar day. */
export interface Day {
  readonly year: number;
  /** 0–11. */
  readonly month: number;
  readonly day: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` in the browser timezone. */
export function toDateInput(at: number | undefined): string {
  if (at === undefined) return '';
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH:MM` in the browser timezone. */
export function toTimeInput(at: number | undefined): string {
  if (at === undefined) return '';
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse `YYYY-MM-DD` to local midnight (epoch ms); `undefined` when empty or not a real date. */
export function fromDateInput(value: string): number | undefined {
  const day = parseDay(value);
  return day === null ? undefined : dayStart(day);
}

/** Parse `YYYY-MM-DD` into a real calendar day, or `null`. */
export function parseDay(value: string): Day | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** Parse `H:MM`/`HH:MM` (24h) into minutes after midnight; `null` when invalid, `undefined` when empty. */
export function parseTime(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function dayStart(day: Day): number {
  return new Date(day.year, day.month, day.day).getTime();
}

function dayOf(at: number): Day {
  const d = new Date(at);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

function isoOf(day: Day): string {
  return `${day.year}-${pad(day.month + 1)}-${pad(day.day)}`;
}

function addDays(day: Day, n: number): Day {
  return dayOf(new Date(day.year, day.month, day.day + n).getTime());
}

function addMonths(day: Day, n: number): Day {
  const last = new Date(day.year, day.month + n + 1, 0).getDate();
  return { ...dayOf(new Date(day.year, day.month + n, 1).getTime()), day: Math.min(day.day, last) };
}

/** Six Monday-first weeks covering `month` (pure; exported for tests). */
export function monthMatrix(year: number, month: number): readonly (readonly Day[])[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start: Day = dayOf(new Date(year, month, 1 - offset).getTime());
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
  );
}

/** Short label for the trigger. */
export function rangeLabel(since: number | undefined, until: number | undefined): string {
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  if (since !== undefined && until !== undefined) {
    return `${fmt.format(new Date(since))} – ${fmt.format(new Date(until))}`;
  }
  if (since !== undefined) return `From ${fmt.format(new Date(since))}`;
  if (until !== undefined) return `Until ${fmt.format(new Date(until))}`;
  return 'Custom';
}

/** Draft of the popover's fields. */
export interface RangeDraft {
  readonly from: string;
  readonly fromTime: string;
  readonly to: string;
  readonly toTime: string;
}

/**
 * Resolve a draft into a window: `from` starts at its time (default 00:00); `to` ends at the end of
 * its minute (default the end of the day, so the picked day is included). Returns an error message
 * when a field is invalid or the window is inverted (pure; exported for tests).
 */
export function resolveDraft(draft: RangeDraft): DateRange | null | { readonly error: string } {
  const from = draft.from.trim() === '' ? null : parseDay(draft.from);
  const to = draft.to.trim() === '' ? null : parseDay(draft.to);
  if (draft.from.trim() !== '' && from === null)
    return { error: 'From is not a date (YYYY-MM-DD).' };
  if (draft.to.trim() !== '' && to === null) return { error: 'To is not a date (YYYY-MM-DD).' };
  const fromTime = parseTime(draft.fromTime);
  const toTime = parseTime(draft.toTime);
  if (fromTime === null || toTime === null) return { error: 'Times use 24-hour HH:MM.' };
  const since = from === null ? undefined : dayStart(from) + (fromTime ?? 0) * 60_000;
  const until =
    to === null
      ? undefined
      : toTime === undefined
        ? dayStart(addDays(to, 1)) - 1
        : dayStart(to) + (toTime + 1) * 60_000 - 1;
  if (since === undefined && until === undefined) return null;
  if (since !== undefined && until !== undefined && since > until) {
    return { error: 'From must be before To.' };
  }
  return { since, until };
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

function sameDay(a: Day | null, b: Day | null): boolean {
  return a !== null && b !== null && a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Month grid picking a from/to pair: first click starts a range, the second ends it. */
function MonthGrid({
  from,
  to,
  onPick,
}: {
  readonly from: Day | null;
  readonly to: Day | null;
  readonly onPick: (day: Day) => void;
}) {
  const today = dayOf(browserClock());
  const [cursor, setCursor] = useState<Day>(() => to ?? from ?? today);
  const gridRef = useRef<HTMLTableElement>(null);
  const weeks = monthMatrix(cursor.year, cursor.month);
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
    new Date(cursor.year, cursor.month, 1),
  );
  const full = new Intl.DateTimeFormat('en-US', { dateStyle: 'full' });
  const lo = from !== null && to !== null && dayStart(to) < dayStart(from) ? to : from;
  const hi = from !== null && to !== null && dayStart(to) < dayStart(from) ? from : to;
  const move = (next: Day) => {
    setCursor(next);
    // Focus follows the cursor after React renders the (possibly new) month.
    requestAnimationFrame(() =>
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${isoOf(next)}"]`)?.focus(),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const steps: Record<string, () => Day> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      PageUp: () => addMonths(cursor, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(cursor, event.shiftKey ? 12 : 1),
      Home: () => addDays(cursor, -((new Date(dayStart(cursor)).getDay() + 6) % 7)),
      End: () => addDays(cursor, 6 - ((new Date(dayStart(cursor)).getDay() + 6) % 7)),
    };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    move(step());
  };
  const Prev = ICONS.chevronLeft;
  const Next = ICONS.chevronRight;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Previous month"
          onClick={() => setCursor(addMonths(cursor, -1))}
        >
          <Prev aria-hidden="true" />
        </Button>
        <p aria-live="polite" className="text-base font-medium">
          {monthName}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Next month"
          onClick={() => setCursor(addMonths(cursor, 1))}
        >
          <Next aria-hidden="true" />
        </Button>
      </div>
      <table
        ref={gridRef}
        aria-label={monthName}
        className="w-full border-separate border-spacing-0"
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {WEEKDAYS.map((d, i) => (
              <th
                key={d}
                scope="col"
                abbr={WEEKDAY_NAMES[i]}
                className="h-8 text-center text-xs font-medium text-muted-foreground"
              >
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={isoOf(week[0] as Day)}>
              {week.map((day) => {
                const outside = day.month !== cursor.month;
                const start = sameDay(day, lo);
                const end = sameDay(day, hi);
                const inside =
                  lo !== null &&
                  hi !== null &&
                  dayStart(day) > dayStart(lo) &&
                  dayStart(day) < dayStart(hi);
                const selected = start || end;
                return (
                  <td
                    key={isoOf(day)}
                    className={cn(
                      'p-0 text-center',
                      inside && 'bg-accent-bg',
                      start && hi !== null && !end && 'rounded-l-md bg-accent-bg',
                      end && lo !== null && !start && 'rounded-r-md bg-accent-bg',
                    )}
                  >
                    <button
                      type="button"
                      data-day={isoOf(day)}
                      tabIndex={sameDay(day, cursor) ? 0 : -1}
                      aria-pressed={selected}
                      aria-current={sameDay(day, today) ? 'date' : undefined}
                      aria-label={full.format(new Date(dayStart(day)))}
                      onClick={() => {
                        setCursor(day);
                        onPick(day);
                      }}
                      className={cn(
                        'focus-ring relative inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-sm tabular-nums transition-colors duration-(--duration-fast) pointer-coarse:size-10',
                        outside ? 'text-muted-foreground' : 'text-foreground',
                        selected
                          ? 'bg-primary font-medium text-primary-foreground hover:bg-primary-hover'
                          : 'hover:bg-accent',
                        sameDay(day, today) &&
                          !selected &&
                          'font-semibold after:absolute after:bottom-1.5 after:size-1 after:rounded-full after:bg-primary',
                      )}
                    >
                      {day.day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Date range picker. */
export function DateRangePicker({ since, until, onChange, className }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RangeDraft>({ from: '', fromTime: '', to: '', toTime: '' });
  const [error, setError] = useState<string | null>(null);
  const ids = { from: useId(), fromTime: useId(), to: useId(), toTime: useId(), error: useId() };
  const active = since !== undefined || until !== undefined;
  const Icon = ICONS.chevronDown;
  const reset = () => {
    // A stored `until` is the last millisecond of a minute or a day; show the day and, when it is
    // not the end of the day, the minute.
    const untilTime = until === undefined ? '' : toTimeInput(until);
    setDraft({
      from: toDateInput(since),
      fromTime: since === undefined || toTimeInput(since) === '00:00' ? '' : toTimeInput(since),
      to: toDateInput(until),
      toTime: untilTime === '23:59' ? '' : untilTime,
    });
    setError(null);
  };
  const set = (patch: Partial<RangeDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };
  const pick = (day: Day) => {
    const iso = isoOf(day);
    const from = parseDay(draft.from);
    const to = parseDay(draft.to);
    // Start a new range unless exactly the start is set; a second pick before the start swaps.
    if (from === null || to !== null) set({ from: iso, to: '' });
    else if (dayStart(day) < dayStart(from)) set({ from: iso, to: draft.from });
    else set({ to: iso });
  };
  const apply = () => {
    const result = resolveDraft(draft);
    if (result !== null && 'error' in result) {
      setError(result.error);
      return;
    }
    onChange(result);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={active}
            className={cn('h-9 pointer-coarse:h-10', className)}
          />
        }
      >
        {rangeLabel(since, until)}
        <Icon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[20.5rem] max-w-[calc(100vw-2rem)] gap-4">
        <form
          noValidate
          className="flex flex-col gap-4"
          aria-describedby={error !== null ? ids.error : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <fieldset className="grid grid-cols-[1fr_5rem] gap-x-2 gap-y-1.5">
            <legend className="sr-only">Window</legend>
            <Label htmlFor={ids.from}>From</Label>
            <Label htmlFor={ids.fromTime} className="text-muted-foreground">
              Time
            </Label>
            <Input
              id={ids.from}
              size="sm"
              inputMode="numeric"
              placeholder="YYYY-MM-DD"
              className="font-mono text-sm"
              value={draft.from}
              aria-invalid={error !== null && draft.from !== '' && parseDay(draft.from) === null}
              onChange={(event) => set({ from: event.target.value })}
            />
            <Input
              id={ids.fromTime}
              size="sm"
              inputMode="numeric"
              placeholder="00:00"
              className="font-mono text-sm"
              value={draft.fromTime}
              onChange={(event) => set({ fromTime: event.target.value })}
            />
            <Label htmlFor={ids.to} className="pt-1.5">
              To
            </Label>
            <Label htmlFor={ids.toTime} className="pt-1.5 text-muted-foreground">
              Time
            </Label>
            <Input
              id={ids.to}
              size="sm"
              inputMode="numeric"
              placeholder="YYYY-MM-DD"
              className="font-mono text-sm"
              value={draft.to}
              aria-invalid={error !== null && draft.to !== '' && parseDay(draft.to) === null}
              onChange={(event) => set({ to: event.target.value })}
            />
            <Input
              id={ids.toTime}
              size="sm"
              inputMode="numeric"
              placeholder="23:59"
              className="font-mono text-sm"
              value={draft.toTime}
              onChange={(event) => set({ toTime: event.target.value })}
            />
          </fieldset>
          <MonthGrid
            key={open ? 'open' : 'closed'}
            from={parseDay(draft.from)}
            to={parseDay(draft.to)}
            onPick={pick}
          />
          {error !== null ? (
            <p id={ids.error} role="alert" className="text-sm text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!active && draft.from === '' && draft.to === ''}
              onClick={() => {
                set({ from: '', fromTime: '', to: '', toTime: '' });
                onChange(null);
                setOpen(false);
              }}
            >
              Clear
            </Button>
            <Button type="submit" size="sm">
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
