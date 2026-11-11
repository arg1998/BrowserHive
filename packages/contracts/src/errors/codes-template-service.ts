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
} as const;
