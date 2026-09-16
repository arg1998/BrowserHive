/** @module contracts/enums/captcha-mode — CaptchaMode enum: CAPTCHA hand-off policy. */

import { z } from 'zod';

/**
 * CAPTCHA hand-off policy. `solver` is reserved and rejected at config time, not implemented.
 */
export const CaptchaMode = z.enum(['attention', 'off']);
/** Union of {@link CaptchaMode} members. */
export type CaptchaMode = z.infer<typeof CaptchaMode>;
