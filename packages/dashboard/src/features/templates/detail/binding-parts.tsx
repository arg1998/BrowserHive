/** @module features/templates/detail/binding-parts — pieces of the automatic re-login editor (spec 13 §8.4): the vault binding picker (handle, title, the origins it fills) and the list of reasons a binding would refuse the template's fill, with **Allow this template** for the ones it fixes and a link to the Vault page for the rest */
import type { BindingProblem, VaultBinding } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { Button } from '@/components/ui/button.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { ALLOW_FIXES, BINDING_PROBLEM_TEXT } from '../relogin-text.ts';

const NONE = '__none__';

/** Pick a binding (or none). */
export function BindingPicker({
  bindings,
  value,
  onChange,
}: {
  readonly bindings: readonly VaultBinding[];
  readonly value: string | null;
  readonly onChange: (handle: string | null) => void;
}) {
  const labelId = useId();
  const helpId = useId();
  const known = value === null || bindings.some((b) => b.handle === value);
  const items = [
    { value: NONE, label: 'No binding (automatic re-login off)' },
    ...bindings.map((b) => ({ value: b.handle, label: `${b.title} · ${b.handle}` })),
    ...(known || value === null ? [] : [{ value, label: `${value} (not found)` }]),
  ];
  const chosen = bindings.find((b) => b.handle === value);
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-base font-medium">
        Vault binding
      </span>
      <Select
        items={items}
        value={value ?? NONE}
        onValueChange={(next) => onChange(next === NONE || next === null ? null : String(next))}
      >
        <SelectTrigger aria-labelledby={labelId} aria-describedby={helpId} className="w-full">
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start">
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={helpId} className="text-sm text-pretty text-muted-foreground">
        {chosen !== undefined
          ? `Fills ${chosen.item_name} on ${chosen.allowed_origins.length > 0 ? chosen.allowed_origins.join(', ') : 'no origin yet'}.`
          : bindings.length === 0
            ? 'No bindings yet. Add one on the Vault page first.'
            : 'A binding names a vault item and the sites it may be filled on.'}{' '}
        <Link
          to="/vault"
          className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
        >
          Vault bindings
        </Link>
      </p>
    </div>
  );
}

/** Why the binding refuses, and the fix. */
export function BindingProblems({
  problems,
  busy,
  onAllow,
}: {
  readonly problems: readonly BindingProblem[];
  readonly busy: boolean;
  readonly onAllow: () => void;
}) {
  const allowable = problems.some((p) => ALLOW_FIXES.has(p));
  return (
    <section
      aria-label="Why the binding can’t be used yet"
      className="flex flex-col gap-2.5 rounded-lg border border-warn-border bg-warn-bg/60 px-3.5 py-3"
    >
      <p className="flex items-center gap-2 font-medium text-warn-text">
        <ICONS.warn aria-hidden="true" className="size-4 shrink-0" />
        The vault would refuse this template’s fill
      </p>
      <ul className="flex list-disc flex-col gap-1.5 pl-10 text-sm text-pretty">
        {problems.map((p) => (
          <li key={p}>{BINDING_PROBLEM_TEXT[p]}</li>
        ))}
      </ul>
      {allowable ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onAllow}>
            {busy ? <Spinner /> : <ICONS.principals aria-hidden="true" />}
            Allow this template…
          </Button>
          <span className="text-sm text-muted-foreground">Widens who can use this credential.</span>
        </div>
      ) : null}
    </section>
  );
}
