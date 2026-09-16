/** @module contracts/enums/actor-kind — ActorKind enum: Who caused an event-log row (`events.actor_kind`). */

import { z } from 'zod';

/**
 * Who caused an event-log row (`events.actor_kind`).
 */
export const ActorKind = z.enum(['agent', 'operator', 'system']);
/** Union of {@link ActorKind} members. */
export type ActorKind = z.infer<typeof ActorKind>;
