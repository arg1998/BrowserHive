/** @module features/notifications/channels/wizard/StepRules — step 4: the channel's name and what it sends: preset cards (Needs me now, Problems, Wrap-ups, Everything) and an Advanced disclosure with categories, minimum severity, session globs, harness, quiet hours with a time zone, content level, screenshots per category with masking (need Full; the ntfy.sh warning), self-destruct per category (Never by default, Telegram at most 47 h) and delete-when-resolved (off by default) (D-35, D-36) */
import type { NotificationCategory, NotificationContentLevel } from '@browserhive/contracts/enums';
import {
  CHANNEL_PRESETS,
  type NotificationChannelRules,
} from '@browserhive/contracts/notifications';
import { useId, useMemo, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import {
  applyPreset,
  CATEGORIES,
  type ChannelDraft,
  isPublicNtfy,
  presetOf,
  ttlChoices,
} from '../model.ts';
import { Field, SwitchField } from './fields.tsx';
import { RadioCard } from './StepPlatform.tsx';

const SEVERITIES = [
  { value: 'info', label: 'Everything (info and up)' },
  { value: 'warn', label: 'Warnings and up' },
  { value: 'error', label: 'Errors and up' },
  { value: 'critical', label: 'Critical only' },
] as const;

const CONTENT: readonly {
  readonly id: NotificationContentLevel;
  readonly label: string;
  readonly describe: string;
}[] = [
  {
    id: 'counts',
    label: 'Counts',
    describe: 'What happened and the session name only. Nothing from the page.',
  },
  {
    id: 'titles',
    label: 'Titles',
    describe: 'Plus the facts: tool, error code, page address (without query). The default.',
  },
  {
    id: 'full',
    label: 'Full',
    describe: "Plus the agent's message and details. Needed for screenshots.",
  },
];

function timeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

/** Props. */
export interface StepRulesProps {
  readonly draft: ChannelDraft;
  readonly onName: (name: string) => void;
  readonly onRules: (rules: NotificationChannelRules) => void;
  readonly errors: Readonly<Record<string, string>>;
  readonly readOnly: boolean;
}

function PerCategorySwitches({
  label,
  describe,
  categories,
  values,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly describe: string;
  readonly categories: readonly (typeof CATEGORIES)[number][];
  readonly values: Readonly<Partial<Record<NotificationCategory, boolean>>> | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: Partial<Record<NotificationCategory, boolean>>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-base font-medium">{label}</legend>
      <p className="-mt-1 text-sm text-muted-foreground">{describe}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {categories.map((c) => (
          <SwitchField
            key={c.id}
            reverse
            size="sm"
            checked={values?.[c.id] === true}
            disabled={disabled}
            onChange={(checked) => onChange({ ...values, [c.id]: checked })}
            className={cn('rounded-lg border px-3 py-2', disabled && 'opacity-60')}
            labelClassName="flex-1 text-sm"
          >
            {c.label}
          </SwitchField>
        ))}
      </div>
    </fieldset>
  );
}

/** Step 4. */
export function StepRules({ draft, onName, onRules, errors, readOnly }: StepRulesProps) {
  const rules = draft.rules;
  const preset = presetOf(rules);
  const [advanced, setAdvanced] = useState(
    preset === null || Object.keys(rules).some((k) => k !== 'categories'),
  );
  const nameId = useId();
  const categoriesId = useId();
  const sessionsId = useId();
  const harnessId = useId();
  const severityId = useId();
  const tzId = useId();
  const zones = useMemo(timeZones, []);
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const set = (patch: Partial<NotificationChannelRules>) => onRules({ ...rules, ...patch });
  const Chevron = advanced ? ICONS.chevronUp : ICONS.chevronDown;
  const content = rules.content ?? 'titles';
  const imagesOn = Object.values(rules.images ?? {}).some((v) => v === true);
  const ttl = ttlChoices(draft.kind);
  const imageCategories = CATEGORIES.filter((c) => c.images);

  return (
    <div className="flex flex-col gap-6">
      <Field
        label="Name"
        htmlFor={nameId}
        help="Shown on the card, in the delivery log and in the CLI (browserhive channels test <name>)."
        error={errors['name']}
        className="max-w-sm"
      >
        <Input
          id={nameId}
          value={draft.name}
          disabled={readOnly}
          spellCheck={false}
          className="font-mono"
          onChange={(e) => onName(e.target.value.trim().toLowerCase())}
        />
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-base font-medium">What should reach you here?</legend>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {CHANNEL_PRESETS.map((p) => (
            <RadioCard
              key={p.id}
              name="preset"
              value={p.id}
              checked={preset === p.id}
              disabled={readOnly}
              onChange={(id) => onRules(applyPreset(rules, id))}
            >
              <span className="flex min-w-0 flex-col gap-1 pr-6">
                <span className="font-semibold">{p.label}</span>
                <span className="text-sm text-muted-foreground">{p.describe}</span>
              </span>
            </RadioCard>
          ))}
        </div>
        {preset === null ? (
          <p className="text-sm text-muted-foreground">Custom categories, set under Advanced.</p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-5 rounded-xl border">
        <button
          type="button"
          className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-4 py-3 text-left focus-ring-inset hover:bg-accent/60"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
        >
          <span className="flex flex-col">
            <span className="text-base font-medium">Advanced</span>
            <span className="text-sm text-muted-foreground">
              Severity, sessions, quiet hours, content, screenshots and self-destruct.
            </span>
          </span>
          <Chevron aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
        {advanced ? (
          <div className="flex flex-col divide-y border-t px-4 [&>*]:py-6">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-base font-medium">Categories</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {CATEGORIES.map((c) => {
                  const on = rules.categories === undefined || rules.categories.includes(c.id);
                  return (
                    <div
                      key={c.id}
                      className="flex items-start gap-2.5 rounded-lg border px-3 py-2"
                    >
                      <Checkbox
                        id={`${categoriesId}-${c.id}`}
                        checked={on}
                        disabled={readOnly}
                        className="mt-0.5"
                        onCheckedChange={(checked) => {
                          const current = rules.categories ?? CATEGORIES.map((x) => x.id);
                          const next = checked
                            ? [...new Set([...current, c.id])]
                            : current.filter((x) => x !== c.id);
                          set({ categories: next.length === CATEGORIES.length ? undefined : next });
                        }}
                      />
                      <label
                        htmlFor={`${categoriesId}-${c.id}`}
                        className="flex cursor-pointer flex-col"
                      >
                        <span className="text-sm font-medium">{c.label}</span>
                        <span className="text-xs text-muted-foreground">{c.describe}</span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </fieldset>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Minimum severity" htmlFor={severityId}>
                <SimpleSelect
                  id={severityId}
                  value={rules.min_severity ?? 'info'}
                  disabled={readOnly}
                  options={SEVERITIES}
                  onValueChange={(v) =>
                    set({ min_severity: v === 'info' ? undefined : (v as 'warn') })
                  }
                />
              </Field>
              <Field
                label="Sessions"
                htmlFor={sessionsId}
                optional
                help="Slug globs, comma-separated: checkout-*, nightly-*"
              >
                <Input
                  id={sessionsId}
                  className="font-mono"
                  disabled={readOnly}
                  defaultValue={(rules.sessions ?? []).join(', ')}
                  onBlur={(e) => {
                    const list = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    set({ sessions: list.length === 0 ? undefined : list });
                  }}
                />
              </Field>
              <Field
                label="Harness"
                htmlFor={harnessId}
                optional
                help="Only from these agents: claude-code, codex…"
              >
                <Input
                  id={harnessId}
                  className="font-mono"
                  disabled={readOnly}
                  defaultValue={(rules.harness ?? []).join(', ')}
                  onBlur={(e) => {
                    const list = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    set({ harness: list.length === 0 ? undefined : list });
                  }}
                />
              </Field>
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="text-base font-medium">Quiet hours</legend>
              <SwitchField
                labelClassName="text-sm"
                checked={rules.quiet_hours !== undefined}
                disabled={readOnly}
                onChange={(checked) =>
                  set({
                    quiet_hours: checked
                      ? { start: '22:00', end: '07:00', time_zone: hostZone }
                      : undefined,
                  })
                }
              >
                Hold back new alerts during these hours (critical ones still come through; silent
                updates always do)
              </SwitchField>
              {rules.quiet_hours !== undefined ? (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="From" htmlFor={`${tzId}-start`}>
                    <Input
                      id={`${tzId}-start`}
                      type="time"
                      className="w-32"
                      disabled={readOnly}
                      value={rules.quiet_hours.start}
                      onChange={(e) =>
                        rules.quiet_hours !== undefined &&
                        set({ quiet_hours: { ...rules.quiet_hours, start: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="Until" htmlFor={`${tzId}-end`}>
                    <Input
                      id={`${tzId}-end`}
                      type="time"
                      className="w-32"
                      disabled={readOnly}
                      value={rules.quiet_hours.end}
                      onChange={(e) =>
                        rules.quiet_hours !== undefined &&
                        set({ quiet_hours: { ...rules.quiet_hours, end: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="Time zone" htmlFor={tzId} className="min-w-56 flex-1">
                    <SimpleSelect
                      id={tzId}
                      value={rules.quiet_hours.time_zone ?? hostZone}
                      disabled={readOnly}
                      options={zones.map((z) => ({ value: z, label: z.replaceAll('_', ' ') }))}
                      onValueChange={(v) =>
                        rules.quiet_hours !== undefined &&
                        set({ quiet_hours: { ...rules.quiet_hours, time_zone: v } })
                      }
                    />
                  </Field>
                </div>
              ) : null}
            </fieldset>

            <fieldset className="flex flex-col gap-3">
              <legend className="text-base font-medium">What the messages may contain</legend>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {CONTENT.map((c) => (
                  <RadioCard
                    key={c.id}
                    name="content"
                    value={c.id}
                    checked={content === c.id}
                    disabled={readOnly}
                    onChange={(v) => {
                      const level = v as NotificationContentLevel;
                      set({
                        content: level === 'titles' ? undefined : level,
                        ...(level !== 'full' && { images: undefined, mask_images: undefined }),
                      });
                    }}
                  >
                    <span className="flex min-w-0 flex-col gap-1 pr-6">
                      <span className="font-semibold">{c.label}</span>
                      <span className="text-sm text-muted-foreground">{c.describe}</span>
                    </span>
                  </RadioCard>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-3">
              <PerCategorySwitches
                label="Screenshots"
                describe={
                  content === 'full'
                    ? 'Attach a screenshot of the page to attention requests, vault fills (taken before the fill) and crashes. Off by default.'
                    : 'Screenshots need the Full content level.'
                }
                categories={imageCategories}
                values={rules.images}
                disabled={readOnly || content !== 'full'}
                onChange={(images) =>
                  set({
                    images,
                    ...(rules.mask_images === undefined &&
                      Object.values(images).some((v) => v === true) && { mask_images: true }),
                  })
                }
              />
              {imagesOn ? (
                <SwitchField
                  labelClassName="text-sm"
                  checked={rules.mask_images === true}
                  disabled={readOnly}
                  onChange={(checked) => set({ mask_images: checked })}
                >
                  Black out form fields in screenshots (a crash's last frame cannot be masked, so it
                  is left out)
                </SwitchField>
              ) : null}
              {imagesOn && draft.kind === 'ntfy' && isPublicNtfy(draft.target['server']) ? (
                <Callout tone="warn" title="Screenshots on ntfy.sh">
                  ntfy.sh keeps attachments on its public server for three hours, and whether their
                  address stays private is not documented. For screenshots, a self-hosted ntfy
                  server is the safer choice.
                </Callout>
              ) : null}
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="text-base font-medium">Self-destruct</legend>
              <p className="-mt-1 text-sm text-muted-foreground">
                BrowserHive deletes its message after a while. Deleting removes it for everyone in
                the chat, but a lock-screen preview someone already saw cannot be taken back.
                {draft.kind === 'telegram'
                  ? " Telegram lets a bot delete messages for 48 hours only, so 47 hours is the longest; Telegram's own auto-delete timer for the chat is a good backstop."
                  : ''}
              </p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {CATEGORIES.map((c) => {
                  const value = rules.ttl_ms?.[c.id];
                  return (
                    <div
                      key={c.id}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                    >
                      <span className="text-sm">{c.label}</span>
                      <SimpleSelect
                        size="sm"
                        aria-label={`Delete ${c.label} messages after`}
                        className="w-44"
                        disabled={readOnly}
                        value={value === undefined ? 'never' : String(value)}
                        options={ttl.map((t) => ({
                          value: t.value === null ? 'never' : String(t.value),
                          label: t.label,
                        }))}
                        onValueChange={(v) => {
                          const next = { ...rules.ttl_ms };
                          if (v === 'never') delete next[c.id];
                          else next[c.id] = Number(v);
                          set({ ttl_ms: Object.keys(next).length === 0 ? undefined : next });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              {Object.entries(errors)
                .filter(([k]) => k.startsWith('rules.ttl_ms'))
                .map(([k, v]) => (
                  <p key={k} className="text-sm text-danger-text" role="alert">
                    {v}
                  </p>
                ))}
            </fieldset>

            <PerCategorySwitches
              label="Delete when resolved"
              describe="Remove the message as soon as its request is resolved or its problem recovers. Off by default."
              categories={CATEGORIES.filter(
                (c) => c.id === 'needs-you' || c.id === 'system' || c.id === 'problems',
              )}
              values={rules.delete_when_resolved}
              disabled={readOnly}
              onChange={(v) => set({ delete_when_resolved: v })}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
