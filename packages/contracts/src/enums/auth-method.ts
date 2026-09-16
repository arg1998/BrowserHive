/** @module contracts/enums/auth-method — AuthMethod enum: How a request was authenticated (D-09 provider chain, spec 03 §3). */

import { z } from 'zod';

/**
 * How a request was authenticated (D-09 provider chain, spec 03 §3).
 */
export const AuthMethod = z.enum(['password-session', 'bearer', 'grant']);
/** Union of {@link AuthMethod} members. */
export type AuthMethod = z.infer<typeof AuthMethod>;
