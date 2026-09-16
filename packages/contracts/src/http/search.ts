/** @module contracts/http/search — command-palette entity search and client error sink (spec 03 §4.8–4.9) */
import { z } from 'zod';
import { SessionId } from '../ids/index.ts';
import { limitQuery } from './common.ts';

/** `GET /search` query (`q` ≥ 2 chars, `limit` ≤ 20). */
export const SearchQuery = z.strictObject({
  q: z.string().trim().min(2).max(100),
  limit: limitQuery(20, 10),
});
/** `GET /search` query. */
export type SearchQuery = z.infer<typeof SearchQuery>;

/** `GET /search` body — one array per entity kind, each capped at `limit`. */
export const SearchResponse = z.object({
  sessions: z.array(z.object({ session_id: SessionId, slug: z.string() })),
  tools: z.array(z.string()),
  vault_handles: z.array(z.string()),
  patterns: z.array(z.string()),
});
/** `GET /search` body. */
export type SearchResponse = z.infer<typeof SearchResponse>;

/** `POST /client-errors` body (204 on success; rate-limited 30/min). */
export const ClientErrorReport = z.strictObject({
  message: z.string().trim().min(1).max(2000),
  stack: z.string().max(16_000).optional(),
  route: z.string().max(512),
  user_agent: z.string().max(512),
  build: z.string().max(128),
});
/** `POST /client-errors` body. */
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;
