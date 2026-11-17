/** @module contracts/enums/headed-windows — HeadedWindows enum: how a headed browser's windows open on the BrowserHive machine's screen (config key `headedWindows`, D-77). */

import { z } from 'zod';

/**
 * How a headed browser's windows open (config key `headedWindows`). `minimized` keeps every window
 * of a headed session minimized, from the first one on (the default, owner's request 2026-11-17);
 * `normal` opens them as ordinary windows. It is also the default `agent_windows` of new templates.
 */
export const HeadedWindows = z.enum(['minimized', 'normal']);
/** Union of {@link HeadedWindows} members. */
export type HeadedWindows = z.infer<typeof HeadedWindows>;
