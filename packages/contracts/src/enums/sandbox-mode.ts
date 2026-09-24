/** @module contracts/enums/sandbox-mode — SandboxMode enum: Chromium sandbox policy (config key `sandbox`). */

import { z } from 'zod';

/**
 * Chromium sandbox policy (config key `sandbox`). `auto` runs each browser sandboxed where it can and falls back where it cannot; `on` requires the sandbox (the server refuses to start, and a session fails, when a browser cannot provide it); `off` never uses it.
 */
export const SandboxMode = z.enum(['auto', 'on', 'off']);
/** Union of {@link SandboxMode} members. */
export type SandboxMode = z.infer<typeof SandboxMode>;
