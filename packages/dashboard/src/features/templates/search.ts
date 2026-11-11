/** @module features/templates/search — URL state of the templates pages (spec 04 §12.14): the list (table params + `status`, `host`), the wizard (`step` 1–5, `template` once created) and the template page (`tab`, `site`) */
import { TemplateHostState, TemplateStatus } from '@browserhive/contracts/enums';
import type { TemplatesQuery } from '@browserhive/contracts/http';
import { z } from 'zod';
import { csvParam, TABLE_SEARCH_DEFAULTS, tableSearchSchema } from '@/lib/search/table.ts';

/** Sort keys of the list (every sortable column). */
export const TEMPLATE_SORT_KEYS = ['name', 'created', 'used', 'sessions'] as const;
/** Sort key. */
export type TemplateSortKey = (typeof TEMPLATE_SORT_KEYS)[number];

const SORT_TO_API: { readonly [K in TemplateSortKey]: TemplatesQuery['sort'] } = {
  name: 'name',
  created: 'created_at',
  used: 'last_used_at',
  sessions: 'in_use',
};

/** `/templates` search. */
export const templatesSearch = tableSearchSchema(TEMPLATE_SORT_KEYS).extend({
  status: csvParam(TemplateStatus),
  host: csvParam(TemplateHostState),
});
/** `/templates` search. */
export type TemplatesSearch = z.infer<typeof templatesSearch>;
/** Defaults omitted from the URL. */
export const TEMPLATES_DEFAULTS = TABLE_SEARCH_DEFAULTS;
/** Keys that count as filters ("Clear all", zero-results). */
export const TEMPLATE_FILTER_KEYS = ['q', 'status', 'host'] as const;

/** `true` when a filter is on. */
export function hasTemplateFilters(search: TemplatesSearch): boolean {
  return TEMPLATE_FILTER_KEYS.some((key) => search[key] !== undefined);
}

/** The REST query of a search. Names sort A→Z unless asked otherwise; the rest newest or most first. */
export function toTemplatesQuery(
  search: TemplatesSearch,
  cursor: string | undefined,
): z.input<typeof TemplatesQuery> {
  const sort = SORT_TO_API[(search.sort as TemplateSortKey | undefined) ?? 'name'];
  const dir = search.dir ?? (sort === 'name' ? 'asc' : 'desc');
  return {
    limit: search.ps,
    total: true,
    sort,
    dir,
    ...(cursor !== undefined && { cursor }),
    ...(search.q !== undefined && { q: search.q }),
    ...(search.status !== undefined && { status: search.status }),
    ...(search.host !== undefined && { host_state: search.host }),
  };
}

/** Wizard steps (spec 13 §7.1). */
export const WIZARD_STEPS = [1, 2, 3, 4, 5] as const;
/** A wizard step. */
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** `/templates/new` search: the step, from step 5 on the template being signed in, and `again`. */
export const wizardSearch = z.object({
  step: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]))
    .optional()
    .catch(undefined),
  template: z
    .string()
    .regex(/^tp-[A-Za-z0-9_-]{10}$/)
    .optional()
    .catch(undefined),
  /** Sign in again to a template that is already ready (a signed-out site; re-login proper is T2). */
  again: z.coerce.number().pipe(z.literal(1)).optional().catch(undefined),
});
/** `/templates/new` search. */
export type WizardSearch = z.infer<typeof wizardSearch>;

/** Template page tabs (spec 13 §11.4). */
export const TEMPLATE_TABS = [
  'sites',
  'sessions',
  'versions',
  'access',
  'settings',
  'activity',
] as const;
/** A template page tab. */
export type TemplateTab = (typeof TEMPLATE_TABS)[number];

/** `/templates/$id` search. */
export const templatePageSearch = z.object({
  tab: z.enum(TEMPLATE_TABS).default('sites').catch('sites'),
  /** A site to focus on the Sites tab (`?site=linkedin.com`). */
  site: z.string().trim().toLowerCase().min(1).max(253).optional().catch(undefined),
});
/** `/templates/$id` search. */
export type TemplatePageSearch = z.infer<typeof templatePageSearch>;
/** Defaults omitted from the URL. */
export const TEMPLATE_PAGE_DEFAULTS = { tab: 'sites' } as const;
