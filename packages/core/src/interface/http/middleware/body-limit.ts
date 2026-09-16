/** @module interface/http/middleware/body-limit — middleware 6: request body size caps (spec 03 §2). */

import { AppError } from '../../../kernel/errors/app-error.ts';

/** Default body cap. */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
/** `/auth/login` body cap. */
export const LOGIN_BODY_LIMIT_BYTES = 64 * 1024;
/** `/vault/import` body cap. */
export const IMPORT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Reads the request body as text within `limit` bytes. A declared `Content-Length` over the limit
 * fails before reading; the decoded size is checked again. Throws 413 `PAYLOAD_TOO_LARGE`.
 */
export async function readBodyWithin(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > limit) throw tooLarge(limit);
  return new TextDecoder().decode(buffer);
}

function tooLarge(limit: number): AppError<'PAYLOAD_TOO_LARGE'> {
  return new AppError(
    'PAYLOAD_TOO_LARGE',
    { limit_bytes: limit },
    { publicMessage: `Request body exceeds ${limit} bytes.` },
  );
}
