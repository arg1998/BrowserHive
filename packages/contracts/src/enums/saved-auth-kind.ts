/** @module contracts/enums/saved-auth-kind — kinds of saved auth snapshots */
import { z } from 'zod';

/** A saved auth snapshot is either a light `storage` state or a heavy full `profile` zip. */
export const SavedAuthKind = z.enum(['storage', 'profile']);
/** Union of {@link SavedAuthKind} values. */
export type SavedAuthKind = z.infer<typeof SavedAuthKind>;
