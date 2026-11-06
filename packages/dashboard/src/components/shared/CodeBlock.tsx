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
  if (overflow === 'wrap') {
    // One command: the button sits beside the text, centred on its first line; words stay whole
    // (inline blocks) so a narrow screen wraps between them, never inside `--admin`.
    return (
      <div
        data-reveal-scope=""
        className={cn(
          'flex min-w-0 items-start gap-2 rounded-lg border bg-muted/50 py-1 pr-1 pl-3 dark:bg-black/20',
          className,
        )}
      >
        <code className="min-w-0 flex-1 py-1 font-mono text-sm leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {code.split(' ').map((word, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the words of a fixed command
            <span key={i}>
              {i === 0 ? null : ' '}
              <span className="inline-block">{word}</span>
            </span>
          ))}
        </code>
        <CopyButton value={code} label={`Copy ${label}`} visibility="always" />
      </div>
    );
  }
  return (
    <div
      data-reveal-scope=""
      className={cn('relative min-w-0 rounded-lg border bg-muted/50 dark:bg-black/20', className)}
    >
      <pre className="overflow-x-auto p-3 pr-12 font-mono text-sm leading-relaxed">{code}</pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={code} label={`Copy ${label}`} visibility="always" />
      </div>
    </div>
  );
}
