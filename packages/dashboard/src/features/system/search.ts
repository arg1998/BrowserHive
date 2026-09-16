/** @module features/system/search — `/system` search params: the section tab (`status` | `tokens` | `config`) and the configuration key filter */
import { z } from 'zod';
import { queryParam } from '@/lib/search/table.ts';

/** Sections of the System page, in tab order. */
export const SYSTEM_SECTIONS = ['status', 'tokens', 'config'] as const;
/** A System section. */
export type SystemSection = (typeof SYSTEM_SECTIONS)[number];

/** Tab labels. */
export const SYSTEM_SECTION_LABEL: { readonly [S in SystemSection]: string } = {
  status: 'Status',
  tokens: 'Agent tokens',
  config: 'Configuration',
};

/** Search schema. */
export const systemSearch = z.object({
  tab: z.enum(SYSTEM_SECTIONS).catch('status').default('status'),
  key: queryParam,
});
/** Parsed search. */
export type SystemSearch = z.infer<typeof systemSearch>;
/** Defaults omitted from the URL. */
export const SYSTEM_DEFAULTS = { tab: 'status' } as const;

/** Section for a raw tab value (unknown values fall back to Status). */
export function systemSection(value: unknown): SystemSection {
  return (SYSTEM_SECTIONS as readonly unknown[]).includes(value)
    ? (value as SystemSection)
    : 'status';
}
