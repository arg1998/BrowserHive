/** @module features/attention/card-parts — pieces of an attention card: the agent's options (choice chips for `{ choices }`, collapsed JSON otherwise) and the reason headline clamped to four lines with Show all */
import { useLayoutEffect, useRef, useState } from 'react';
import { JsonView } from '@/components/shared/JsonView.tsx';
import { cn } from '@/lib/utils.ts';

/** `true` when the request carries options worth showing. */
export function hasOptions(options: unknown): boolean {
  if (options === null || options === undefined) return false;
  if (typeof options === 'object') return Object.keys(options).length > 0;
  return true;
}

/** String choices offered by the agent (`{ choices: [...] }`), else `null`. */
export function choicesOf(options: unknown): readonly string[] | null {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return null;
  const record = options as Record<string, unknown>;
  const choices = record['choices'];
  if (Object.keys(record).length !== 1 || !Array.isArray(choices)) return null;
  return choices.every((c) => typeof c === 'string') ? (choices as string[]) : null;
}

/** The agent's options: choice chips for the common `{ choices }` shape, otherwise collapsed JSON. */
export function AgentOptions({ options }: { readonly options: unknown }) {
  const choices = choicesOf(options);
  if (choices !== null) {
    return (
      <ul className="flex flex-wrap gap-1.5" aria-label="Choices">
        {choices.map((choice) => (
          <li
            key={choice}
            className="rounded-md bg-muted px-2 py-0.5 font-mono text-sm dark:bg-white/[0.06]"
          >
            {choice}
          </li>
        ))}
      </ul>
    );
  }
  return <JsonView value={options} collapseAt={1} />;
}

/** The agent's reason: a regular-weight 16px headline clamped to four lines, with "Show all" when it is longer. */
export function Reason({ id, text }: { readonly id: string; readonly text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reason keeps the clamped box height, so no resize fires; re-measure on text
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      if (!open) setClamped(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, text]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <h3
        ref={ref}
        id={id}
        className={cn(
          'text-md font-normal text-pretty break-words text-foreground',
          !open && 'line-clamp-4',
        )}
      >
        {text}
      </h3>
      {clamped || open ? (
        <button
          type="button"
          aria-expanded={open}
          className="-mx-1 cursor-pointer rounded-sm px-1 text-sm font-medium text-primary hover:underline focus-ring"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}
