/** @module features/vault/bindings/binding-form — binding editor form schema (handle grammar from contracts), line-list parsing, handle derivation and the form → `PUT` body mapping (spec 04 §12.7) */
import {
  PutVaultBindingRequest,
  VAULT_HANDLE_RE,
  type VaultBinding,
} from '@browserhive/contracts/http';
import { z } from 'zod';

/** Allowed origin: exact host (optionally with port) or a `*.domain` wildcard. */
export const ORIGIN_RE =
  /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/** Split a textarea into trimmed non-empty lines (commas also separate). */
export function parseLines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Derive a handle matching `VAULT_HANDLE_RE` from a group and item name (`Work` + `GitHub Login` → `work.github-login`). */
export function deriveHandle(groupName: string | null, itemName: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '');
  const parts = [groupName === null ? '' : slug(groupName), slug(itemName)].filter((p) => p !== '');
  return parts.join('.').slice(0, 128);
}

/** Form values (textareas hold one entry per line). */
export const bindingFormSchema = z
  .object({
    handle: z
      .string()
      .trim()
      .regex(
        VAULT_HANDLE_RE,
        'Lowercase letters, digits, ".", "_" or "-", starting with a letter or digit (max 128).',
      ),
    title: z.string().trim().max(200, 'At most 200 characters.'),
    item_name: z
      .string()
      .trim()
      .min(1, 'An item name is required (must match a backend item).')
      .max(200),
    item_id: z.string().trim().max(128),
    group_id: z.string().max(128),
    allowed_origins: z.string(),
    authorized_session_slugs: z.string(),
    authorized_principals: z.string(),
    allow_all_sessions: z.boolean(),
    redact_username: z.boolean(),
    require_no_evaluate: z.boolean(),
    dashboard_confirm: z.boolean(),
  })
  .superRefine((values, ctx) => {
    const bad = parseLines(values.allowed_origins).find((o) => !ORIGIN_RE.test(o));
    if (bad !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowed_origins'],
        message: `"${bad}" is not a host or *.domain wildcard.`,
      });
    }
    const parsed = PutVaultBindingRequest.safeParse(toPutBody(values));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: 'custom',
          path: [String(issue.path[0] ?? 'handle')],
          message: issue.message,
        });
      }
    }
  });
/** Form values. */
export type BindingFormValues = z.infer<typeof bindingFormSchema>;

/** Empty form for a new binding. */
export const EMPTY_BINDING_FORM: BindingFormValues = {
  handle: '',
  title: '',
  item_name: '',
  item_id: '',
  group_id: '',
  allowed_origins: '',
  authorized_session_slugs: '',
  authorized_principals: '',
  allow_all_sessions: false,
  redact_username: false,
  require_no_evaluate: false,
  dashboard_confirm: false,
};

/** Form values for an existing binding. */
export function bindingToForm(binding: VaultBinding): BindingFormValues {
  return {
    handle: binding.handle,
    title: binding.title,
    item_name: binding.item_name,
    item_id: binding.item_id,
    group_id: binding.group_id ?? '',
    allowed_origins: binding.allowed_origins.join('\n'),
    authorized_session_slugs: binding.authorized_session_slugs.join('\n'),
    authorized_principals: binding.authorized_principals.join('\n'),
    allow_all_sessions: binding.allow_all_sessions,
    redact_username: binding.redact_username,
    require_no_evaluate: binding.require_no_evaluate,
    dashboard_confirm: binding.dashboard_confirm,
  };
}

/** `PUT /vault/bindings/{handle}` body for form values. */
export function toPutBody(values: BindingFormValues): z.input<typeof PutVaultBindingRequest> {
  return {
    title: values.title.trim() === '' ? values.item_name.trim() : values.title.trim(),
    item_name: values.item_name.trim(),
    ...(values.item_id.trim() !== '' && { item_id: values.item_id.trim() }),
    group_id: values.group_id === '' ? null : values.group_id,
    allowed_origins: parseLines(values.allowed_origins),
    authorized_session_slugs: values.allow_all_sessions
      ? []
      : parseLines(values.authorized_session_slugs),
    authorized_principals: parseLines(values.authorized_principals),
    allow_all_sessions: values.allow_all_sessions,
    redact_username: values.redact_username,
    require_no_evaluate: values.require_no_evaluate,
    dashboard_confirm: values.dashboard_confirm,
  };
}

/** The binding as it would look after the save (optimistic row). */
export function optimisticBinding(
  previous: VaultBinding | undefined,
  values: BindingFormValues,
  now: number,
): VaultBinding {
  const body = toPutBody(values);
  return {
    handle: values.handle,
    title: body.title ?? values.handle,
    item_name: body.item_name ?? '',
    item_id: body.item_id ?? previous?.item_id ?? '',
    group_id: body.group_id ?? null,
    allowed_origins: body.allowed_origins ?? [],
    authorized_principals: body.authorized_principals ?? [],
    authorized_session_slugs: body.authorized_session_slugs ?? [],
    allow_all_sessions: values.allow_all_sessions,
    redact_username: values.redact_username,
    require_no_evaluate: values.require_no_evaluate,
    dashboard_confirm: values.dashboard_confirm,
    created_at: previous?.created_at ?? now,
    updated_at: now,
    version: (previous?.version ?? 0) + 1,
  };
}
