/** @module contracts/errors/codes-template-service — REST-only session template codes (spec 13 §12): names, deletes, versions */
import { z } from 'zod';
import { defineError } from './spec.ts';

/** Session template codes operators get from REST; agents never receive them. */
export const TEMPLATE_SERVICE_ERRORS = {
  TEMPLATE_NAME_TAKEN: defineError({
    code: 'TEMPLATE_NAME_TAKEN',
    httpStatus: 409,
    category: 'domain',
    retryable: 'different_args',
    title: 'Template name in use',
    message: "A session template named '{name}' already exists.",
    hint: 'Pick another name.',
    details: z.object({ name: z.string() }),
    docs: true,
    cause: 'Template names are unique: agents address a template by its name (spec 13 §2.1).',
    resolution: 'Choose a different name, or delete the existing template first.',
  }),
  TEMPLATE_IN_USE: defineError({
    code: 'TEMPLATE_IN_USE',
    httpStatus: 409,
    category: 'domain',
    retryable: 'different_args',
    title: 'Template has live sessions',
    message:
      "Template '{template_id}' has {live_sessions} live session(s). Close them, or delete with force=true.",
    hint: 'Retry with ?force=true to close the sessions and delete the template.',
    details: z.object({ template_id: z.string(), live_sessions: z.number().int().nonnegative() }),
    docs: true,
    cause: 'Deleting a template stops its browser, which would end the sessions launched from it.',
    resolution:
      'Close the sessions first, or pass `force=true` (they close with `closed_reason: operator`).',
  }),
  TEMPLATE_VERSION_NOT_FOUND: defineError({
    code: 'TEMPLATE_VERSION_NOT_FOUND',
    httpStatus: 404,
    category: 'domain',
    retryable: 'never',
    title: 'Template version not found',
    message: "Template '{template_id}' has no version {version}.",
    hint: 'List the versions with GET /api/v1/templates/{template_id}/versions.',
    details: z.object({
      template_id: z.string(),
      version: z.union([z.number().int(), z.literal('latest')]),
    }),
    docs: true,
    cause:
      'The version was never written, was deleted by retention (`templateVersionsKeep`), or the rolling checkpoint (`latest`) has not been written yet (spec 13 §3.9).',
    resolution: 'Pick a version from the list; pin versions you want to keep past retention.',
  }),
  TEMPLATE_VERSION_UNREADABLE: defineError({
    code: 'TEMPLATE_VERSION_UNREADABLE',
    httpStatus: 409,
    category: 'domain',
    retryable: 'after_operator',
    title: 'Template version unreadable',
    message:
      "Version {version} of template '{template_id}' cannot be read with the current key (key id {key_id}).",
    hint: 'Set the key that wrote it as templateKeyPrevious, or run browserhive templates rekey.',
    details: z.object({
      template_id: z.string(),
      version: z.union([z.number().int(), z.literal('latest')]),
      key_id: z.string(),
    }),
    docs: true,
    cause:
      'The encrypted file was written with another key, no key resolves (`TEMPLATE_KEY_MISSING`), the file is missing, or it failed authentication (altered, truncated or moved from another template or slot; spec 13 §2.4).',
    resolution:
      'Restore the key that wrote it (`templateKey`, or `templateKeyPrevious` until `browserhive templates rekey` has run); a file that fails authentication cannot be recovered.',
  }),
  SITE_PACK_NOT_FOUND: defineError({
    code: 'SITE_PACK_NOT_FOUND',
    httpStatus: 404,
    category: 'domain',
    retryable: 'never',
    title: 'Site pack not found',
    message: "No site pack '{pack_id}'.",
    hint: 'List the packs with GET /api/v1/site-packs.',
    details: z.object({ pack_id: z.string() }),
    docs: true,
    cause:
      'No source (bundled, local file) offers a pack with that id, or site packs are off (`sitePacks=false`).',
    resolution: "Use the id shown on the Site packs page (the pack's registrable domain).",
  }),
  SITE_PACK_INVALID: defineError({
    code: 'SITE_PACK_INVALID',
    httpStatus: 400,
    category: 'domain',
    retryable: 'different_args',
    title: 'Site pack invalid',
    message: 'The site pack from {source} is not valid: {issues_text}',
    hint: 'Fix the listed fields; `browserhive sitepacks verify <file>` checks a file offline.',
    details: z.object({
      source: z.string(),
      issues: z.array(z.object({ path: z.string(), message: z.string() })),
      issues_text: z.string(),
    }),
    docs: true,
    cause:
      "The pack failed the schema (`SitePackV1`, unknown keys are refused) or a refinement of spec 13 §9.10: a URL or glob outside the pack's domains, a probe path its own guards match, a selector outside the allowed CSS grammar, a number outside the binary's bounds, or a file over 64 KiB.",
    resolution:
      'Correct the fields named in `issues`; see docs/guide/site-packs.md for the format.',
  }),
  SITE_PACK_UPDATE_NOT_PENDING: defineError({
    code: 'SITE_PACK_UPDATE_NOT_PENDING',
    httpStatus: 409,
    category: 'domain',
    retryable: 'never',
    title: 'No such pending version',
    message: "Version {version} of site pack '{pack_id}' is not pending.",
    hint: 'Reload the Site packs page and pick a pending version.',
    details: z.object({ pack_id: z.string(), version: z.number().int() }),
    docs: true,
    cause:
      'The version is already approved, was rejected or superseded, or was never offered (spec 13 §10.6).',
    resolution: 'Pick a version listed under Updates available.',
  }),
} as const;
