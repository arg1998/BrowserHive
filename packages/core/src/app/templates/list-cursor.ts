/** @module app/templates/list-cursor — the keyset cursor of `GET /templates` (spec 03 §5): the last row's sort value and id, opaque to clients. */

import { z } from 'zod';
import { AppError } from '../../kernel/errors/app-error.ts';

/** A position in the sorted template list. */
export interface ListCursor {
  readonly key: number | string;
  readonly id: string;
}

const RESOURCE = 'templates';
const cursorSchema = z.object({
  r: z.literal(RESOURCE),
  k: z.union([z.number(), z.string()]),
  id: z.string(),
});

/** Encodes a cursor as base64url JSON. */
export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(
    JSON.stringify({ r: RESOURCE, k: cursor.key, id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes a cursor; absent means the first page.
 *
 * @throws AppError `VALIDATION_FAILED` for a malformed cursor or one minted for another resource.
 */
export function decodeListCursor(cursor: string | undefined): ListCursor | null {
  if (cursor === undefined || cursor === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    raw = undefined;
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      issues: [
        { path: 'cursor', message: `cursor is not valid for ${RESOURCE}`, code: 'invalid_cursor' },
      ],
    });
  }
  return { key: parsed.data.k, id: parsed.data.id };
}
