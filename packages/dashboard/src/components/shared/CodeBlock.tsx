/** @module components/shared/CodeBlock — a monospace block with an always-visible copy button: environment lines in the channel wizard, help commands in the daemon-unreachable dialog */
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface CodeBlockProps {
  /** The exact text copied (and shown). */
  readonly code: string;
  /** What the block holds; the button is named `Copy <label>`. */
  readonly label: string;
  /**
   * `scroll` (default): lines keep their layout and the block scrolls sideways (multi-line
   * snippets). `wrap`: one shell command that wraps between words on a narrow screen.
   */
  readonly overflow?: 'scroll' | 'wrap';
  readonly className?: string;
}

/** A code block with a copy button. */
export function CodeBlock({ code, label, overflow = 'scroll', className }: CodeBlockProps) {
  return (
    <div
      data-reveal-scope=""
      className={cn('relative min-w-0 rounded-lg border bg-muted/50 dark:bg-black/20', className)}
    >
      <pre
        className={cn(
          'p-3 pr-12 font-mono text-sm leading-relaxed',
          overflow === 'wrap' ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto',
        )}
      >
        {code}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={code} label={`Copy ${label}`} visibility="always" />
      </div>
    </div>
  );
}
