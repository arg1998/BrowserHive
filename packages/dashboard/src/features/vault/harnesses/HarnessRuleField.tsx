/** @module features/vault/harnesses/HarnessRuleField — the Harnesses field of the binding and group-policy editors (D-48, spec 04 §12.7): `aria-pressed` chips for All / the known harnesses / Unknown, custom names with a case-sensitive input, seen-name suggestions, the one-line "restricts, does not verify" note and the four warnings */
import { harnessLabel, UNKNOWN_HARNESS } from '@browserhive/contracts/harness';
import type { VaultHarnessesResponse } from '@browserhive/contracts/http';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { cn } from '@/lib/utils.ts';
import {
  addCustomName,
  customNames,
  type HarnessChip,
  type HarnessList,
  harnessChips,
  harnessWarnings,
  replaceEntry,
  seenSlugs,
  seenSuggestions,
  toggleHarness,
} from './harness-rule.ts';

/** Props. */
export interface HarnessRuleFieldProps {
  /** `null` = every harness, `[]` = none. */
  readonly value: HarnessList;
  readonly onChange: (next: string[] | null) => void;
  /** What the rule guards, for the copy: `binding`, `folder` or `template`. */
  readonly noun: 'binding' | 'folder' | 'template';
  /** `GET /vault/harnesses`; `undefined` while loading (no suggestions, no recent-session warnings). */
  readonly seen?: VaultHarnessesResponse | undefined;
  readonly disabled?: boolean;
}

const CHIP =
  'inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-(--duration-fast) focus-ring pointer-coarse:h-10 pointer-coarse:px-3.5 disabled:cursor-not-allowed disabled:opacity-50';
const CHIP_ON =
  'border-accent-border bg-accent-bg font-medium text-accent-text hover:bg-accent-bg-hover';
const CHIP_OFF =
  'border-input bg-card text-foreground hover:border-border-strong hover:bg-accent dark:bg-transparent';
const CHIP_DASHED =
  'border-dashed border-border-strong bg-transparent text-muted-foreground hover:border-ring hover:bg-accent hover:text-foreground';

/** One `aria-pressed` toggle chip. */
function ToggleChip({
  pressed,
  onPress,
  disabled,
  children,
  className,
  title,
}: {
  readonly pressed: boolean;
  readonly onPress: () => void;
  readonly disabled?: boolean | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly title?: string;
}) {
  const Check = ICONS.check;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onPress}
      className={cn(CHIP, pressed ? CHIP_ON : CHIP_OFF, className)}
    >
      {pressed ? <Check aria-hidden="true" className="-ml-0.5 size-3.5 shrink-0" /> : null}
      {children}
    </button>
  );
}

/** "Seen recently" dot, read out to screen readers. */
function SeenDot() {
  return (
    <>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success-solid" />
      <span className="sr-only">(seen recently)</span>
    </>
  );
}

function KnownChip({
  chip,
  value,
  onChange,
  disabled,
}: {
  readonly chip: HarnessChip;
  readonly value: HarnessList;
  readonly onChange: (next: string[] | null) => void;
  readonly disabled: boolean | undefined;
}) {
  return (
    <ToggleChip
      pressed={chip.selected}
      disabled={disabled}
      onPress={() => onChange(toggleHarness(value, chip.slug))}
      {...(chip.seen && { title: 'Seen on this daemon in the last 30 days' })}
    >
      <span className="truncate">{chip.label}</span>
      {chip.seen ? <SeenDot /> : null}
    </ToggleChip>
  );
}

/** The Harnesses field. */
export function HarnessRuleField({ value, onChange, noun, seen, disabled }: HarnessRuleFieldProps) {
  const id = useId();
  const [showMore, setShowMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const recent = seenSlugs(seen);
  const chips = harnessChips(value, recent);
  const customs = customNames(value);
  const suggestions = seenSuggestions(value, seen);
  const warnings = harnessWarnings(value, seen);
  const all = value === null;
  const unknownSelected = value?.includes(UNKNOWN_HARNESS) === true;

  const Plus = ICONS.plus;
  const Close = ICONS.close;
  const Chevron = ICONS.chevronDown;

  const openInput = () => {
    setAdding(true);
    setError(null);
    queueMicrotask(() => inputRef.current?.focus());
  };
  const closeInput = () => {
    setAdding(false);
    setDraft('');
    setError(null);
    queueMicrotask(() => addButtonRef.current?.focus());
  };
  const add = (raw: string, viaInput: boolean) => {
    const result = addCustomName(value, raw);
    if (!result.ok) {
      if (viaInput) setError(result.error);
      return;
    }
    onChange(result.list);
    if (viaInput) {
      setDraft('');
      setError(null);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add(draft, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeInput();
    }
  };

  const noteId = `${id}-note`;
  const inputId = `${id}-custom`;
  const errorId = `${id}-error`;
  const hintId = `${id}-custom-hint`;

  return (
    <fieldset className="flex min-w-0 flex-col gap-2.5" aria-describedby={noteId}>
      <legend className="mb-1.5 text-sm font-medium">Harnesses</legend>

      <div className="flex flex-wrap items-center gap-1.5">
        <ToggleChip pressed={all} disabled={disabled} onPress={() => onChange(null)}>
          All harnesses
        </ToggleChip>
        {chips.primary.map((chip) => (
          <KnownChip
            key={chip.slug}
            chip={chip}
            value={value}
            onChange={onChange}
            disabled={disabled}
          />
        ))}
        {showMore
          ? chips.more.map((chip) => (
              <KnownChip
                key={chip.slug}
                chip={chip}
                value={value}
                onChange={onChange}
                disabled={disabled}
              />
            ))
          : null}
        <ToggleChip
          pressed={unknownSelected}
          disabled={disabled}
          onPress={() => onChange(toggleHarness(value, UNKNOWN_HARNESS))}
          title="Sessions whose client could not be identified"
          className={unknownSelected ? undefined : 'italic'}
        >
          Unknown
          {recent.has(UNKNOWN_HARNESS) ? <SeenDot /> : null}
        </ToggleChip>
        {chips.more.length > 0 ? (
          <button
            type="button"
            aria-expanded={showMore}
            onClick={() => setShowMore((open) => !open)}
            className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-full px-2.5 text-sm text-link transition-colors duration-(--duration-fast) focus-ring hover:bg-accent pointer-coarse:h-10"
          >
            {showMore ? 'Fewer harnesses' : `More harnesses (${chips.more.length})`}
            <Chevron
              aria-hidden="true"
              className={cn(
                'size-3.5 transition-transform duration-(--duration-fast)',
                showMore && 'rotate-180',
              )}
            />
          </button>
        ) : null}
      </div>

      {customs.length > 0 || !adding ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {customs.map((name) => (
            <span
              key={name}
              className={cn(CHIP, CHIP_ON, 'cursor-default gap-1 pr-1 font-mono')}
              title={`Matches a client that declares exactly "${name}"`}
            >
              <span className="truncate">{name}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove custom name ${name}`}
                onClick={() => onChange((value ?? []).filter((entry) => entry !== name))}
                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-accent-text/80 transition-colors focus-ring-inset hover:bg-accent-bg-hover hover:text-accent-text pointer-coarse:size-8"
              >
                <Close aria-hidden="true" className="size-3.5" />
              </button>
            </span>
          ))}
          {adding ? null : (
            <button
              ref={addButtonRef}
              type="button"
              disabled={disabled}
              onClick={openInput}
              className={cn(CHIP, CHIP_DASHED)}
            >
              <Plus aria-hidden="true" className="-ml-0.5 size-3.5" />
              Add custom name
            </button>
          )}
        </div>
      ) : null}

      {adding ? (
        <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={inputId} className="text-sm font-medium">
              Custom harness name
            </label>
            <Chip tone="warn">
              <ICONS.warn aria-hidden="true" className="size-3" />
              case-sensitive
            </Chip>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              ref={inputRef}
              id={inputId}
              value={draft}
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder="e.g. Nightly Scraper"
              className="font-mono sm:flex-1"
              aria-invalid={error !== null}
              aria-describedby={[hintId, error !== null ? errorId : ''].filter(Boolean).join(' ')}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={onKeyDown}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-9 flex-1 sm:flex-none"
                onClick={() => add(draft, true)}
              >
                Add
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-9" onClick={closeInput}>
                Done
              </Button>
            </div>
          </div>
          <p id={hintId} className="text-sm text-muted-foreground">
            Matched exactly against the name the client declares (header, environment variable,
            <code className="mx-1 font-mono text-xs">?harness=</code>or{' '}
            <code className="font-mono text-xs">_meta</code>).
          </p>
          {error !== null ? (
            <p id={errorId} role="alert" className="text-sm text-danger-text">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-sm text-muted-foreground">Declared here recently:</span>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              disabled={disabled}
              aria-label={`Add custom name ${name}`}
              onClick={() => add(name, false)}
              className={cn(CHIP, CHIP_DASHED, 'font-mono')}
            >
              <Plus aria-hidden="true" className="-ml-0.5 size-3.5 shrink-0" />
              <span className="truncate">{name}</span>
            </button>
          ))}
        </div>
      ) : null}

      <p id={noteId} className="text-sm text-muted-foreground">
        Harness names are reported by the client: this restricts which agents can{' '}
        {noun === 'template' ? 'use it' : 'fill'}, but does not verify them.{' '}
        <a
          href={docsUrl('vaultHarnesses')}
          target="_blank"
          rel="noreferrer"
          className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
        >
          How it works
        </a>
      </p>

      {warnings.map((warning) => {
        switch (warning.kind) {
          case 'empty':
            return (
              <Callout
                key="empty"
                tone="warn"
                title={`No harness can ${noun === 'template' ? 'use' : 'fill'} this ${noun}`}
              >
                An empty list refuses every session. Pick a harness, or choose All harnesses.
              </Callout>
            );
          case 'lookalike':
            return (
              <Callout
                key={`lookalike:${warning.entry}`}
                tone="warn"
                title={`"${warning.entry}" is matched exactly`}
              >
                {/* The fix sits under the text: the editors are narrow, a side column would squeeze it. */}
                <p>
                  Did you mean the built-in {harnessLabel(warning.slug)}? A custom name only matches
                  a client that declares exactly this text.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => onChange(replaceEntry(value, warning.entry, warning.slug))}
                >
                  Use {harnessLabel(warning.slug)}
                </Button>
              </Callout>
            );
          case 'blocks-recent':
            return (
              <Callout key="blocks-recent" tone="warn" title="Would refuse every recent session">
                None of the {warning.sessions} session{warning.sessions === 1 ? '' : 's'} launched
                here in the last 30 days would be allowed. Check the names, or add the harness your
                agents report.
              </Callout>
            );
          case 'shared-principal':
            return (
              <Callout
                key="shared-principal"
                tone="info"
                title="Every recent session uses one principal"
              >
                Harness names guard against mistakes, not against a client that misreports itself.
                For a real boundary, give each agent its own API token and authorize its principal.{' '}
                <a
                  href={docsUrl('agentTokens')}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
                >
                  Per-agent tokens
                </a>
              </Callout>
            );
          default:
            return null;
        }
      })}
    </fieldset>
  );
}
