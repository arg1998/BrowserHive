/** @module contracts/enums/auth-mode — AuthMode enum: MCP front-door authentication mode. */

import { z } from 'zod';

/**
 * MCP front-door authentication mode. `token` requires a bearer on `/mcp` and turns on session ownership enforcement.
 */
export const AuthMode = z.enum(['off', 'token']);
/** Union of {@link AuthMode} members. */
export type AuthMode = z.infer<typeof AuthMode>;
