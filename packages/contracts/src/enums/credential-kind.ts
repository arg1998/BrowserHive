/** @module contracts/enums/credential-kind — CredentialKind enum: Kind of a stored credential (`credentials.kind`, D-09). */

import { z } from 'zod';

/**
 * Kind of a stored credential (`credentials.kind`, D-09).
 */
export const CredentialKind = z.enum(['password', 'api_token']);
/** Union of {@link CredentialKind} members. */
export type CredentialKind = z.infer<typeof CredentialKind>;
