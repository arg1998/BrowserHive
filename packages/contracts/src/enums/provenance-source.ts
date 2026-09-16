/** @module contracts/enums/provenance-source — ProvenanceSource enum: Where a configuration value came from (D-06 ladder). */

import { z } from 'zod';

/**
 * Where a configuration value came from (D-06 ladder). `env(otel)` is the standard `OTEL_*` sub-source below `BROWSERHIVE_*` env; `derived` marks a default computed from another key or the host.
 */
export const ProvenanceSource = z.enum(['default', 'env', 'env(otel)', 'file', 'cli', 'derived']);
/** Union of {@link ProvenanceSource} members. */
export type ProvenanceSource = z.infer<typeof ProvenanceSource>;
