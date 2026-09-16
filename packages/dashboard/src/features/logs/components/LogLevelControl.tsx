/** @module features/logs/components/LogLevelControl — runtime log level in a header popover: a default level select plus per-module overrides (module + level rows), previewed as the spec and sent to `PATCH /system/log-level` (spec 03 §4.7) */
import type { LogLevel } from '@browserhive/contracts/enums';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useSetLogLevel } from '../api.ts';
import {
  draftSpec,
  formatLogLevelSpec,
  LOG_LEVELS,
  LOG_MODULE_RE,
  type LogLevelSetting,
} from '../log-filters.ts';

const LEVEL_OPTIONS = LOG_LEVELS.map((level) => ({ value: level, label: level }));

interface Draft {
  readonly root: LogLevel;
  readonly overrides: readonly { readonly id: number; module: string; level: LogLevel }[];
}

function toDraft(setting: LogLevelSetting | undefined): Draft {
  return {
    root: setting?.root ?? 'info',
    overrides: (setting?.overrides ?? []).map((o, id) => ({ id, ...o })),
  };
}

/** Props. */
export interface LogLevelControlProps {
  /** The setting currently in force (from `/system/config`). */
  readonly current: LogLevelSetting | undefined;
  /** Icon-only trigger (phones); the level stays in the accessible name. */
  readonly compact?: boolean;
}

/** Header control. */
export function LogLevelControl({ current, compact = false }: LogLevelControlProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(current));
  const [showError, setShowError] = useState(false);
  const mutation = useSetLogLevel();
  const rootId = useId();
  const errorId = useId();
  const result = draftSpec(draft);
  const error = 'error' in result ? result.error : null;
  const currentSpec = current === undefined ? undefined : formatLogLevelSpec(current);
  // The preview only appears once the draft differs from what is in force.
  const changed = 'spec' in result && result.spec !== currentSpec;
  const Plus = ICONS.plus;
  const Remove = ICONS.close;
  const Chevron = ICONS.chevronDown;
  const Gauge = ICONS.system;
  const summary =
    current === undefined
      ? '…'
      : `${current.root}${current.overrides.length > 0 ? ` +${current.overrides.length}` : ''}`;
  const update = (id: number, patch: Partial<{ module: string; level: LogLevel }>) =>
    setDraft((d) => ({
      ...d,
      overrides: d.overrides.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    }));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraft(toDraft(current));
          setShowError(false);
        }
      }}
    >
      {compact ? (
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Daemon log level: ${summary}`}
            />
          }
        >
          <Gauge aria-hidden="true" />
        </PopoverTrigger>
      ) : (
        <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>
          <span className="text-muted-foreground">Daemon log level</span>
          <span className="font-mono">{summary}</span>
          <Chevron aria-hidden="true" className="text-muted-foreground" />
        </PopoverTrigger>
      )}
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] gap-4">
        <div className="flex flex-col gap-0.5">
          <PopoverTitle>Daemon log level</PopoverTitle>
          <PopoverDescription>
            The lowest level the daemon records, from now on. The Level filter on this page only
            changes which recorded lines you see.
          </PopoverDescription>
        </div>
        <form
          noValidate
          aria-label="Log level"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if ('error' in result) {
              setShowError(true);
              return;
            }
            if (!changed) {
              setOpen(false);
              return;
            }
            mutation.mutate(result.spec, { onSuccess: () => setOpen(false) });
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={rootId} className="text-sm font-medium">
              Default level
            </label>
            <SimpleSelect
              id={rootId}
              size="sm"
              className="w-32"
              value={draft.root}
              options={LEVEL_OPTIONS}
              onValueChange={(value) =>
                setDraft((d) => ({ ...d, root: (value as LogLevel) ?? d.root }))
              }
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Module overrides</legend>
            {draft.overrides.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Every module logs at the default level.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {draft.overrides.map((o, index) => (
                  <li key={o.id} className="flex items-center gap-2">
                    <Input
                      size="sm"
                      aria-label={`Module ${index + 1}`}
                      placeholder="sessions"
                      autoComplete="off"
                      spellCheck={false}
                      className="min-w-0 flex-1 font-mono"
                      value={o.module}
                      aria-invalid={showError && !LOG_MODULE_RE.test(o.module.trim())}
                      aria-describedby={showError && error !== null ? errorId : undefined}
                      onChange={(event) => update(o.id, { module: event.target.value })}
                    />
                    <SimpleSelect
                      size="sm"
                      aria-label={`Level for module ${index + 1}`}
                      className="w-28 min-w-0"
                      value={o.level}
                      options={LEVEL_OPTIONS}
                      onValueChange={(value) => update(o.id, { level: value as LogLevel })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove override ${index + 1}`}
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          overrides: d.overrides.filter((x) => x.id !== o.id),
                        }))
                      }
                    >
                      <Remove aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="-ml-2"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    overrides: [
                      ...d.overrides,
                      {
                        id: Math.max(-1, ...d.overrides.map((x) => x.id)) + 1,
                        module: '',
                        level: 'debug',
                      },
                    ],
                  }))
                }
              >
                <Plus aria-hidden="true" />
                Add override
              </Button>
            </div>
          </fieldset>
          {showError && error !== null ? (
            <p id={errorId} role="alert" className="text-sm text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t pt-3">
            {changed ? (
              <p className="mr-auto min-w-0 text-sm text-muted-foreground">
                Sets{' '}
                <code className="font-mono text-sm [overflow-wrap:anywhere] text-foreground">
                  {'spec' in result ? result.spec : ''}
                </code>
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={mutation.isPending}>
                {mutation.isPending ? <Spinner /> : null}
                Apply
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
