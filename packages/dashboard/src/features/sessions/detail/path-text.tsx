/** @module features/sessions/detail/path-text — file paths and shell commands that wrap only after a `/` (or at spaces), never mid-token ("scratch / pad") */
import { Fragment } from 'react';
import { cn } from '@/lib/utils.ts';

/** Mono text with a soft line-break opportunity after every `/`. */
export function PathText({
  value,
  className,
}: {
  readonly value: string;
  readonly className?: string;
}) {
  const parts = value.split('/');
  return (
    <code
      className={cn(
        'min-w-0 font-mono text-sm [overflow-wrap:break-word] break-normal select-all',
        className,
      )}
    >
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: path segments repeat and never reorder
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? (
            <>
              /<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </code>
  );
}
