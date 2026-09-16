/** @module contracts/enums/vault-backend-kind — VaultBackendKind enum: Vault backend identifiers (D-14). */

import { z } from 'zod';

/**
 * Vault backend identifiers (D-14). Only `off` and `bitwarden` are implemented; `local`, `onepassword` and `http` are reserved and rejected at config time.
 */
export const VaultBackendKind = z.enum(['off', 'bitwarden', 'local', 'onepassword', 'http']);
/** Union of {@link VaultBackendKind} members. */
export type VaultBackendKind = z.infer<typeof VaultBackendKind>;
