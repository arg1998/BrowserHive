/** @module components/shared/JsonView — JSON rendered as React text nodes (never innerHTML), collapsible ≥ 2 levels deep with chevrons, copy button in its own gutter (never over text) */
import { useState } from 'react';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { CopyButton } from './CopyButton.tsx';

/** Props. */
export interface JsonViewProps {
  /** Parsed value or a JSON string (parsed leniently; invalid text renders as text). */
  readonly value: unknown;
  readonly className?: string;
  /** Depth at which nodes start collapsed. */
  readonly collapseAt?: number;
  readonly copy?: boolean;
}

/** Parse a JSON string when given one; otherwise pass through. */
export function coerceJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function Primitive({ value }: { readonly value: unknown }) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  switch (typeof value) {
    case 'string':
      return <span className="text-success-text">{JSON.stringify(value)}</span>;
    case 'number':
    case 'bigint':
      return <span className="text-info-text">{String(value)}</span>;
    case 'boolean':
      return <span className="text-warn-text">{String(value)}</span>;
    default:
      return <span className="text-muted-foreground">{String(value)}</span>;
  }
}

function Node({
  value,
  depth,
  collapseAt,
  name,
}: {
  readonly value: unknown;
  readonly depth: number;
  readonly collapseAt: number;
  readonly name?: string | undefined;
}) {
  const [open, setOpen] = useState(depth < collapseAt);
  const isArray = Array.isArray(value);
  const isObject = typeof value === 'object' && value !== null;
  const label =
    name !== undefined ? <span className="text-foreground">{JSON.stringify(name)}: </span> : null;
  if (!isObject) {
    return (
      <div>
        {label}
        <Primitive value={value} />
      </div>
    );
  }
  const entries: readonly [string, unknown][] = isArray
    ? value.map((v, i): [string, unknown] => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const Chevron = ICONS.chevronRight;
  const open_ = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  if (entries.length === 0) {
    return (
      <div>
        {label}
        {open_}
        {close}
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        className="-ml-4 inline-flex cursor-pointer items-center gap-0.5 rounded-xs text-left hover:bg-accent"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Chevron
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)',
            open && 'rotate-90',
          )}
        />
        {label}
        {open_}
        {!open ? <span className="text-muted-foreground"> {entries.length} items </span> : null}
        {!open ? close : null}
      </button>
      {open ? (
        <div className="ml-[-0.5625rem] border-l border-border pl-6">
          {entries.map(([key, child]) => (
            <Node
              key={key}
              value={child}
              depth={depth + 1}
              collapseAt={collapseAt}
              name={isArray ? undefined : key}
            />
          ))}
        </div>
      ) : null}
      {open ? <div>{close}</div> : null}
    </div>
  );
}

/** JSON tree. */
export function JsonView({ value, className, collapseAt = 2, copy = true }: JsonViewProps) {
  const parsed = coerceJson(value);
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  return (
    <div
      className={cn(
        'relative flex min-w-0 items-start rounded-lg border bg-muted/60 font-mono text-sm leading-5 dark:bg-black/20',
        className,
      )}
    >
      <div className="min-w-0 flex-1 overflow-x-auto py-3 pr-2 pl-7 [overflow-wrap:anywhere]">
        {typeof parsed === 'string' ? (
          <pre className="-ml-4 whitespace-pre-wrap break-words">{parsed}</pre>
        ) : (
          <Node value={parsed} depth={0} collapseAt={collapseAt} />
        )}
      </div>
      {copy ? (
        <div className="sticky top-0 shrink-0 p-1.5">
          <CopyButton value={text} label="Copy JSON" visibility="always" />
        </div>
      ) : null}
    </div>
  );
}
