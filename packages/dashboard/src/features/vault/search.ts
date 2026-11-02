/** @module features/vault/search — `/vault` search params: `tab`, bindings table params + `group`, tester inputs (`tester`, `slug`, `harness`, `declared`, `entry`) (spec 04 §12.7) */
import { z } from 'zod';
import { queryParam, tableSearchSchema } from '@/lib/search/table.ts';

/** Tabs of the vault page (URL `?tab`). */
export const VAULT_TABS = ['bindings', 'groups', 'confirms', 'tester', 'transfer'] as const;
/** Vault tab. */
export type VaultTab = (typeof VAULT_TABS)[number];

/** Bindings sort keys (the server whitelist of `GET /vault/bindings`). */
export const BINDING_SORT_KEYS = ['handle', 'updated_at', 'created_at'] as const;

const shortText = z.string().trim().max(512).optional().catch(undefined);

/** Search schema. */
export const vaultSearch = tableSearchSchema(BINDING_SORT_KEYS).extend({
  tab: z.enum(VAULT_TABS).catch('bindings').default('bindings'),
  group: z.string().min(1).max(128).optional().catch(undefined),
  folder: z.string().min(1).max(128).optional().catch(undefined),
  tester: shortText,
  slug: z.string().trim().max(64).optional().catch(undefined),
  /** Tester: the harness slug to test as (D-48). */
  harness: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(32)
    .optional()
    .catch(undefined),
  /** Tester: the exact declared harness name. */
  declared: z.string().trim().min(1).max(64).optional().catch(undefined),
  entry: queryParam,
});
/** Parsed search. */
export type VaultSearch = z.infer<typeof vaultSearch>;
/** Defaults omitted from the URL. */
export const VAULT_DEFAULTS = { page: 1, ps: 25, tab: 'bindings' } as const;
