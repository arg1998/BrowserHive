/** @module contracts/enums/persistence-mode — session persistence modes */
import { z } from 'zod';

/**
 * How a session's browser state is kept: `memory` (nothing survives close), `persistent` (managed
 * on-disk profile), `storage-state` (light cookies, localStorage and IndexedDB snapshot restored at launch).
 */
export const PersistenceMode = z.enum(['memory', 'persistent', 'storage-state']);
/** Union of {@link PersistenceMode} values. */
export type PersistenceMode = z.infer<typeof PersistenceMode>;
