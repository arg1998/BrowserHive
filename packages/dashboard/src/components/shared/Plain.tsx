/** @module components/shared/Plain — a string from elsewhere (a site pack, the registry, a server message) as plain text: unprintable characters shown as U+FFFD (`printable`) and the whole bidi-isolated in a `<bdi>` (spec 13 §9.10; review #100 H1) */
import { printable } from '@/lib/format/printable.ts';

/** The text, printable and isolated. `multiline` keeps line feeds (render with `whitespace-pre-line`). */
export function Plain({
  children,
  className,
  multiline,
}: {
  readonly children: string | number | null | undefined;
  readonly className?: string | undefined;
  readonly multiline?: boolean;
}) {
  if (children === null || children === undefined) return null;
  const text =
    typeof children === 'number'
      ? String(children)
      : printable(children, { multiline: multiline === true });
  return <bdi className={className}>{text}</bdi>;
}
