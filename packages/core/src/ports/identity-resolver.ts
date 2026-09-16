/** @module ports/identity-resolver — resolves the LaunchIdentity (display fingerprint + geo) before launch (spec 11 §2.6); adapted from infra/browsers at composition. */

import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import type { LaunchIdentity, LaunchWarning, ProxySpec } from './browser-driver.ts';

/** What the `resolveIdentity` phase knows (fingerprint on). */
export interface IdentityRequest {
  readonly sessionId: string;
  readonly headless: boolean;
  readonly launchOptions?: LaunchOptions;
  readonly contextOptions?: BrowserContextOptions;
  /** The resolved first-class proxy (D-13), if any. */
  readonly proxy: ProxySpec | null;
  /** Display seed restored from `<name>.identity.json` beside a restored profile, when present. */
  readonly restoredSeed?: string | null;
}

/** The phase result: the identity for the launcher plus the warnings to broadcast. */
export interface ResolvedIdentity {
  readonly identity: LaunchIdentity;
  readonly warnings: readonly LaunchWarning[];
}

/** Coherence and downgrade rules 1–5 (spec 11 §2.6). Pure apart from the geo seed resolver. */
export interface IdentityResolver {
  resolve(request: IdentityRequest): Promise<ResolvedIdentity>;
}
