/** @module components/shared/CopyButton — clipboard copy (execCommand fallback), revealed on hover/focus of its scope, tooltip + live-region confirmation */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useRowControlTabIndex } from './row-context.ts';

/** Copy text to the clipboard; falls back to a temporary textarea + `execCommand` when the API is unavailable. */
export async function copyText(value: string, doc: Document = document): Promise<boolean> {
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (clipboard !== undefined && doc.defaultView?.isSecureContext === true) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // fall through to the execCommand path
    }
  }
  const area = doc.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.className = 'sr-only';
  doc.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Props. */
export interface CopyButtonProps {
  readonly value: string;
  /** Accessible name and tooltip (`Copy session id`). */
  readonly label: string;
  readonly className?: string;
  readonly size?: 'icon-xs' | 'icon-sm';
  /**
   * `hover` (default): hidden until its `data-reveal-scope` ancestor (row, card, `CopyValue`) is
   * hovered or focused; always visible on touch. `always`: permanently visible.
   */
  readonly visibility?: 'hover' | 'always';
}

/** Icon button that copies `value`, confirms with a check + tooltip, and announces "Copied". */
export function CopyButton({
  value,
  label,
  className,
  size = 'icon-xs',
  visibility = 'hover',
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const tabIndex = useRowControlTabIndex();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (timer.current === null ? undefined : clearTimeout(timer.current)), []);
  const onClick = useCallback(async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  }, [value]);
  const Icon = state === 'copied' ? ICONS.check : ICONS.copy;
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0',
        visibility === 'hover' && state === 'idle' && 'reveal',
        className,
      )}
    >
      <Hint label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}>
        <Button
          type="button"
          variant="ghost"
          size={size}
          aria-label={label}
          tabIndex={tabIndex}
          className={cn(state === 'copied' && '[&_svg]:text-success-text!')}
          onClick={(event) => {
            event.stopPropagation();
            void onClick();
          }}
        >
          <Icon aria-hidden="true" />
        </Button>
      </Hint>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}

/**
 * Value with a copy button that appears on hover/focus of the value (or of an enclosing row).
 * `truncate: [head, tail]` middle-truncates the display; the full value is in a tooltip.
 */
export function CopyValue({
  value,
  display,
  truncate,
  label,
  mono = true,
  className,
}: {
  readonly value: string;
  readonly display?: ReactNode;
  readonly truncate?: readonly [number, number];
  readonly label?: string;
  readonly mono?: boolean;
  readonly className?: string;
}) {
  const shortened =
    truncate !== undefined && value.length > truncate[0] + truncate[1] + 1
      ? `${value.slice(0, truncate[0])}…${value.slice(value.length - truncate[1])}`
      : undefined;
  const shown = display ?? shortened ?? value;
  const text = <span className={cn('min-w-0 truncate', mono && 'font-mono text-sm')}>{shown}</span>;
  return (
    <span
      data-reveal-scope=""
      className={cn('inline-flex max-w-full min-w-0 items-center gap-0.5', className)}
    >
      {shortened !== undefined && display === undefined ? (
        <Hint label={<span className="font-mono break-all">{value}</span>}>
          <span className="min-w-0 truncate" tabIndex={-1}>
            {text}
          </span>
        </Hint>
      ) : (
        text
      )}
      <CopyButton value={value} label={label ?? 'Copy'} />
    </span>
  );
}
