/** @module components/shared/time-range-control — segmented control over the time-range vocabulary plus a custom `DateRangePicker` writing `since`/`until` */
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { TIME_RANGES, type TimeRangeValue } from '@/lib/search/time-range.ts';
import { cn } from '@/lib/utils.ts';
import { DateRangePicker } from './date-range-picker.tsx';

/** A patch the control writes to the URL: `range` or a custom `since`/`until` pair (which clears the other). */
export interface TimeRangePatch {
  readonly range?: TimeRangeValue | undefined;
  readonly since?: number | undefined;
  readonly until?: number | undefined;
}

/** Props. */
export interface TimeRangeControlProps {
  readonly value: TimeRangeValue;
  /** Custom window bounds (epoch ms); when either is set the picker shows as active. */
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  /** Restrict the vocabulary (e.g. notifications use `24h | 7d | 30d | all`). */
  readonly options?: readonly TimeRangeValue[];
  /** Hide the custom picker. */
  readonly custom?: boolean;
  readonly onChange: (patch: TimeRangePatch) => void;
  readonly label?: string;
  readonly className?: string;
}

/** Time range control. */
export function TimeRangeControl({
  value,
  since,
  until,
  options,
  custom = true,
  onChange,
  label = 'Time range',
  className,
}: TimeRangeControlProps) {
  const hasCustom = since !== undefined || until !== undefined;
  const items = TIME_RANGES.filter((r) => options === undefined || options.includes(r.value));
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <ToggleGroup
        aria-label={label}
        size="sm"
        spacing={0}
        value={hasCustom ? [] : [value]}
        onValueChange={(next: readonly unknown[]) => {
          const picked = next[0];
          const range = items.find((r) => r.value === picked);
          if (range !== undefined) {
            onChange({ range: range.value, since: undefined, until: undefined });
          }
        }}
      >
        {items.map((range) => (
          <ToggleGroupItem key={range.value} value={range.value} aria-label={`Last ${range.label}`}>
            {range.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {custom ? (
        <DateRangePicker
          since={since}
          until={until}
          onChange={(next) =>
            onChange(
              next === null
                ? { since: undefined, until: undefined }
                : { since: next.since, until: next.until },
            )
          }
        />
      ) : null}
    </div>
  );
}
