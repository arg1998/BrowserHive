/** @module ports/session-policies — installs per-session interception policies (the blocklist route first; the InterceptionChain seam) on the session's browser host. */

import type { BrowserHost, LaunchWarning } from './browser-driver.ts';

/**
 * Arms request-level policies on a freshly launched session before the agent can navigate
 * (spec 11 §5). Failures are returned as warnings (e.g. `BLOCKLIST_ROUTE_FAILED`), never thrown:
 * the tool-level checks still stand.
 */
export interface SessionPolicyInstaller {
  /** Registers the session's policies with `host` (an exclusive host: its own context). */
  install(
    host: BrowserHost,
    context: { readonly sessionId: string },
  ): Promise<readonly LaunchWarning[]>;
}
