/** @module features/logs/search — `/logs` search params: level csv, module csv (root prefixes), session_id, trace_id, request_id, q, since, until (spec 04 §12.9), plus the client-side `dashboard` view filter. Live/paused is view state, never in the URL. */
import { LogLevel } from '@browserhive/contracts/enums';
import { z } from 'zod';
import { epochParam } from '@/features/overview/search.ts';
import { csvParam, queryParam } from '@/lib/search/table.ts';

/** Search schema. */
export const logsSearch = z.object({
  level: csvParam(LogLevel),
  module: csvParam(z.string().min(1).max(64)),
  session_id: z.string().min(1).optional().catch(undefined),
  trace_id: z.string().min(1).max(64).optional().catch(undefined),
  request_id: z.string().min(1).max(128).optional().catch(undefined),
  q: queryParam,
  since: epochParam,
  until: epochParam,
  /** `show` includes dashboard traffic (successful API reads, socket lifecycle), hidden by default. */
  dashboard: z.enum(['show']).optional().catch(undefined),
});
/** Parsed search. */
export type LogsSearch = z.infer<typeof logsSearch>;
