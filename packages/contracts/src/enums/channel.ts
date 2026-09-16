/** @module contracts/enums/channel — browser channel names accepted by `launch_session` and `defaultChannel` */
import { z } from 'zod';

/**
 * Public browser channel names. Chromium-family only (frozen tool vocabulary, D-12): `chromium` is
 * Playwright's bundled full Chromium, `chrome` and `edge` are the user's installed branded builds.
 */
export const Channel = z.enum(['chromium', 'chrome', 'edge']);
/** Union of {@link Channel} values. */
export type Channel = z.infer<typeof Channel>;
