/** @module components/shared/breakable — long tokens (paths, URLs, user agents, ids) that wrap at their natural boundaries instead of mid-word */
import { Fragment, type ReactNode } from 'react';

/** Characters after which a long token may wrap. */
const BOUNDARY = /([/\\.\-_?&=:@,;+])/;

/**
 * Split `text` into pieces with a `<wbr>` after every boundary character (`/ . - _ ? & = : @ , ; +`),
 * so a long path wraps at `/` rather than inside a segment. Pair with `overflow-wrap: break-word`,
 * which still breaks a single segment that is wider than its box (pure; exported for tests).
 */
export function breakableParts(text: string): readonly string[] {
  const parts: string[] = [];
  let current = '';
  for (const piece of text.split(BOUNDARY)) {
    if (piece === '') continue;
    current += piece;
    if (BOUNDARY.test(piece) && piece.length === 1) {
      parts.push(current);
      current = '';
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** Text that wraps at token boundaries. Non-string children render unchanged. */
export function Breakable({ children }: { readonly children: ReactNode }) {
  if (typeof children !== 'string') return <>{children}</>;
  const parts = breakableParts(children);
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string, never reordered
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  );
}
