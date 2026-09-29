/** @module features/notifications/channels/wizard/ReportsSection — "Reports" in the rules step (D-43, D-44): the digest (Off · Every day · Every week, a 24-hour time, a weekday) with the next run in the channel's zone, the channel's time zone (default the host's, which also applies to quiet hours), and "Tell me when something looks off" with its checks in plain words; the thresholds live in Advanced ({@link AnomalyThresholds}) */
import {
  ANOMALY_CHECK_TEXT,
  ANOMALY_CHECKS,
  ANOMALY_DEFAULTS,
  type AnomalyRule,
  DEFAULT_DIGEST_AT,
  type NotificationChannelRules,
  WEEKDAYS,
  type Weekday,
} from '@browserhive/contracts/notifications';
import { useId } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { formatInZone, nextDigestAt, WEEKDAY_LABEL, zoneLabel } from '../model.ts';
import { Field } from './fields.tsx';
import { TimeZonePicker } from './TimeZonePicker.tsx';

type Frequency = 'off' | 'day' | 'week';

/** Props. */
export interface ReportsSectionProps {
  readonly rules: NotificationChannelRules;
  readonly onRules: (rules: NotificationChannelRules) => void;
  /** The zone BrowserHive runs in (`host_time_zone`). */
  readonly hostZone: string;
  readonly readOnly: boolean;
  readonly errors: Readonly<Record<string, string>>;
  /** Now, for the next run (injectable for tests). */
  readonly now?: number;
}

/** The digest, the zone and the anomaly switch. */
export function ReportsSection({
  rules,
  onRules,
  hostZone,
  readOnly,
  errors,
  now = Date.now(),
}: ReportsSectionProps) {
  const id = useId();
  const digest = rules.digest;
  const frequency: Frequency = digest === undefined ? 'off' : digest.every;
  const zone = rules.time_zone ?? hostZone;
  const anomaly = rules.anomaly !== undefined;
  const on = digest !== undefined || anomaly;
  const Digest = ICONS.digest;
  const Radar = ICONS.anomaly;
  const Globe = ICONS.globe;
  const set = (patch: Partial<NotificationChannelRules>) => {
    const next: NotificationChannelRules = { ...rules, ...patch };
    // One zone per channel: an older quiet-hours zone gives way to the channel's.
    if ('time_zone' in patch && next.quiet_hours?.time_zone !== undefined) {
      const { time_zone: _old, ...hours } = next.quiet_hours;
      onRules({ ...next, quiet_hours: hours });
      return;
    }
    onRules(next);
  };
  const setFrequency = (f: Frequency) => {
    if (f === 'off') return set({ digest: undefined });
    const at = digest?.at ?? DEFAULT_DIGEST_AT;
    set({
      digest:
        f === 'week' ? { every: 'week', at, day: digest?.day ?? 'mon' } : { every: 'day', at },
    });
  };
  const next = digest === undefined ? null : nextDigestAt(digest, zone, now);

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border transition-colors',
        on && 'border-accent-border',
      )}
    >
      <div
        className={cn('flex items-start gap-4 p-4', on && 'bg-accent-bg/40 dark:bg-accent-bg/25')}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            on
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground dark:bg-white/[0.06]',
          )}
        >
          <Digest className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 id={`${id}-title`} className="text-base font-medium">
            Reports
          </h3>
          <p className="text-sm text-muted-foreground">
            A summary on your schedule, and a heads-up when something looks off. They come to this
            channel whatever its categories, and nothing is sent when there is nothing to tell.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t p-4">
        <div className="flex flex-col gap-2">
          <span id={`${id}-digest`} className="text-sm font-medium">
            Digest
          </span>
          <ToggleGroup
            aria-labelledby={`${id}-digest`}
            size="sm"
            spacing={0}
            disabled={readOnly}
            value={[frequency]}
            onValueChange={(nextValue: readonly unknown[]) => {
              const v = nextValue[0];
              if (v === 'off' || v === 'day' || v === 'week') setFrequency(v);
            }}
            className="w-fit"
          >
            <ToggleGroupItem value="off">Off</ToggleGroupItem>
            <ToggleGroupItem value="day">Every day</ToggleGroupItem>
            <ToggleGroupItem value="week">Every week</ToggleGroupItem>
          </ToggleGroup>
          {digest !== undefined ? (
            <div className="flex flex-wrap items-end gap-3 pt-1">
              {digest.every === 'week' ? (
                <Field label="On" htmlFor={`${id}-day`}>
                  <SimpleSelect
                    id={`${id}-day`}
                    className="w-40"
                    disabled={readOnly}
                    value={digest.day ?? 'mon'}
                    options={WEEKDAYS.map((d) => ({ value: d, label: WEEKDAY_LABEL[d] }))}
                    onValueChange={(v) => set({ digest: { ...digest, day: v as Weekday } })}
                  />
                </Field>
              ) : null}
              <Field label="At" htmlFor={`${id}-at`}>
                <Input
                  id={`${id}-at`}
                  type="time"
                  className="w-32"
                  disabled={readOnly}
                  value={digest.at}
                  onChange={(e) => {
                    if (/^\d{2}:\d{2}$/.test(e.target.value)) {
                      set({ digest: { ...digest, at: e.target.value } });
                    }
                  }}
                />
              </Field>
              {next !== null ? (
                <p className="pb-2 text-sm text-muted-foreground" aria-live="polite">
                  Next digest: <span className="text-foreground">{formatInZone(next, zone)}</span>
                </p>
              ) : null}
            </div>
          ) : null}
          {digest !== undefined ? (
            <p className="text-sm text-muted-foreground">
              {digest.every === 'week' ? 'The last seven days' : 'The last 24 hours'} in numbers:
              sessions, tool calls and errors, attention requests, vault fills, blocked requests,
              the slowest tool, the top errors and open problems. If BrowserHive was off at that
              time, the digest comes when it starts again, marked late.
            </p>
          ) : null}
          {errors['rules.digest.day'] !== undefined ? (
            <p className="text-sm text-danger-text" role="alert">
              {errors['rules.digest.day']}
            </p>
          ) : null}
        </div>

        <Field
          label={
            <span className="flex items-center gap-1.5">
              <Globe aria-hidden="true" className="size-4 text-muted-foreground" />
              Time zone
            </span>
          }
          htmlFor={`${id}-tz`}
          help={`Digest times and quiet hours follow this zone. Now: ${formatInZone(now, zone)} in ${zoneLabel(zone)}.`}
          error={errors['rules.time_zone']}
          className="max-w-md"
        >
          <TimeZonePicker
            id={`${id}-tz`}
            value={rules.time_zone}
            hostZone={hostZone}
            disabled={readOnly}
            onChange={(z) => set({ time_zone: z })}
          />
        </Field>

        <div className="flex items-start gap-3 rounded-lg border p-3">
          <Radar aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label
              htmlFor={`${id}-anomaly`}
              className={cn(
                'text-sm font-medium',
                readOnly ? 'cursor-not-allowed' : 'cursor-pointer',
              )}
            >
              Tell me when something looks off
            </label>
            <p className="text-sm text-muted-foreground">
              Checked every hour; silent unless a check crosses its threshold, then updated when it
              is back to normal.
            </p>
            {anomaly ? (
              <ul className="mt-1 flex flex-col gap-0.5 text-sm" aria-label="What is checked">
                {ANOMALY_CHECKS.map((check) => {
                  const off = checkOff(rules.anomaly ?? {}, check);
                  return (
                    <li
                      key={check}
                      className={cn(
                        'flex items-center gap-2',
                        off && 'text-muted-foreground line-through',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          off ? 'bg-border-strong' : 'bg-primary',
                        )}
                      />
                      {ANOMALY_CHECK_TEXT[check]}
                      {off ? <span className="sr-only">(off)</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
          <Switch
            id={`${id}-anomaly`}
            checked={anomaly}
            disabled={readOnly}
            onCheckedChange={(checked) =>
              set({ anomaly: checked ? (rules.anomaly ?? {}) : undefined })
            }
          />
        </div>
      </div>
    </section>
  );
}

/** Whether one anomaly check is switched off in a rule. */
export function checkOff(rule: AnomalyRule, check: (typeof ANOMALY_CHECKS)[number]): boolean {
  switch (check) {
    case 'error_rate':
      return rule.error_rate === null;
    case 'attention':
      return rule.attention_minutes === null;
    case 'blocked':
      return rule.blocked_spike === null;
    case 'capacity':
      return rule.capacity === false;
    case 'degraded':
      return rule.degraded === false;
  }
}

/** The anomaly thresholds (Advanced): each with its default as placeholder, and a switch per check. */
export function AnomalyThresholds({
  rule,
  onChange,
  readOnly,
}: {
  readonly rule: AnomalyRule;
  readonly onChange: (rule: AnomalyRule) => void;
  readonly readOnly: boolean;
}) {
  const id = useId();
  const number = (
    key: 'error_rate' | 'min_calls' | 'attention_minutes' | 'blocked_spike' | 'blocked_min',
    raw: string,
  ) => {
    const value = raw.trim() === '' ? undefined : Number(raw);
    const next = { ...rule };
    if (value === undefined || !Number.isFinite(value)) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const rows: readonly {
    readonly check: (typeof ANOMALY_CHECKS)[number];
    readonly fields: readonly {
      readonly key:
        | 'error_rate'
        | 'min_calls'
        | 'attention_minutes'
        | 'blocked_spike'
        | 'blocked_min';
      readonly label: string;
      readonly unit: string;
      readonly step: number;
    }[];
  }[] = [
    {
      check: 'error_rate',
      fields: [
        { key: 'error_rate', label: 'Alert at', unit: '% failed', step: 1 },
        { key: 'min_calls', label: 'With at least', unit: 'calls an hour', step: 1 },
      ],
    },
    {
      check: 'attention',
      fields: [
        { key: 'attention_minutes', label: 'Alert after', unit: 'minutes waiting', step: 5 },
      ],
    },
    {
      check: 'blocked',
      fields: [
        { key: 'blocked_spike', label: 'Alert at', unit: '× the usual hourly count', step: 0.5 },
        { key: 'blocked_min', label: 'And at least', unit: 'blocked an hour', step: 10 },
      ],
    },
    { check: 'capacity', fields: [] },
    { check: 'degraded', fields: [] },
  ];
  const toggle = (check: (typeof ANOMALY_CHECKS)[number], on: boolean) => {
    const next = { ...rule };
    switch (check) {
      case 'error_rate':
        if (on) delete next.error_rate;
        else next.error_rate = null;
        break;
      case 'attention':
        if (on) delete next.attention_minutes;
        else next.attention_minutes = null;
        break;
      case 'blocked':
        if (on) delete next.blocked_spike;
        else next.blocked_spike = null;
        break;
      case 'capacity':
        if (on) delete next.capacity;
        else next.capacity = false;
        break;
      case 'degraded':
        if (on) delete next.degraded;
        else next.degraded = false;
        break;
    }
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-base font-medium">Anomaly checks</legend>
      <p className="-mt-1 text-sm text-muted-foreground">
        Each check alerts once when it crosses, and clears only well below its threshold, so it does
        not flap. Empty fields use the default.
      </p>
      <div className="flex flex-col divide-y rounded-lg border">
        {rows.map(({ check, fields }) => {
          const off = checkOff(rule, check);
          return (
            <div
              key={check}
              className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
                <Switch
                  id={`${id}-${check}`}
                  size="sm"
                  checked={!off}
                  disabled={readOnly}
                  onCheckedChange={(checked) => toggle(check, checked)}
                />
                <label
                  htmlFor={`${id}-${check}`}
                  className={cn('cursor-pointer', off && 'text-muted-foreground')}
                >
                  {ANOMALY_CHECK_TEXT[check]}
                </label>
              </div>
              {fields.length > 0 && !off ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-10 sm:pl-0">
                  {fields.map((f) => (
                    <span
                      key={f.key}
                      className="flex items-center gap-1.5 text-sm text-muted-foreground"
                    >
                      {f.label}
                      <Input
                        size="sm"
                        type="number"
                        inputMode="decimal"
                        step={f.step}
                        className="w-20 text-right tabular-nums"
                        disabled={readOnly}
                        placeholder={String(ANOMALY_DEFAULTS[f.key])}
                        aria-label={`${ANOMALY_CHECK_TEXT[check]}: ${f.label} (${f.unit})`}
                        defaultValue={
                          rule[f.key] === undefined || rule[f.key] === null
                            ? ''
                            : String(rule[f.key])
                        }
                        onBlur={(e) => number(f.key, e.target.value)}
                      />
                      {f.unit}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
