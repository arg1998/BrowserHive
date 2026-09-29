/** @module features/notifications/reports/search — `/notifications/reports` search params: kind csv (daily digest, weekly digest, anomaly alert), channel (a channel id, or `in-app` for reports that reached no channel), range (7d|30d|all, default 30d), page, ps (spec 04 §12.11.2, D-45) */
import { ReportKind } from '@browserhive/contracts/http';
import { z } from 'zod';
import { csvParam, pageParam, pageSizeParam, TABLE_SEARCH_DEFAULTS } from '@/lib/search/table.ts';

/** The history's window vocabulary. */
export const REPORT_RANGES = ['7d', '30d', 'all'] as const;

/** Search schema. */
export const reportsSearch = z.object({
  kind: csvParam(ReportKind),
  channel: z.string().max(80).optional().catch(undefined),
  range: z.enum(REPORT_RANGES).catch('30d').default('30d'),
  page: pageParam,
  ps: pageSizeParam,
});
/** Parsed search. */
export type ReportsSearch = z.infer<typeof reportsSearch>;
/** Defaults omitted from the URL. */
export const REPORTS_DEFAULTS = { ...TABLE_SEARCH_DEFAULTS, range: '30d' } as const;
