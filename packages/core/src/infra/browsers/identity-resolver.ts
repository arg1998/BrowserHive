/** @module infra/browsers/identity-resolver — coherence and downgrade rules 1–5 producing the LaunchIdentity before launch (spec 11 §2.6). */

import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import type {
  GeoSeed,
  LaunchIdentity,
  LaunchWarning,
  ProxySpec,
} from '../../ports/browser-driver.ts';
import type { GeoSeedResolver } from '../../ports/geo-seed-resolver.ts';
import { deriveFingerprint } from './fingerprint.ts';
import { callerGeoSeed, resolveHostGeoSeed } from './geo-seed.ts';
import type { HostFacts } from './host-facts.ts';
import { byoProxyPresent } from './pass-through.ts';

/** What the pipeline knows when the `resolveIdentity` phase runs (fingerprint on). */
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

/** Collaborators of {@link resolveIdentity}. */
export interface IdentityResolverDeps {
  readonly geoSeed: GeoSeedResolver;
  readonly host: HostFacts;
}

/** The phase result: the identity for the launcher plus the warnings to broadcast. */
export interface ResolvedIdentity {
  readonly identity: LaunchIdentity;
  readonly warnings: readonly LaunchWarning[];
}

/**
 * Build the session's display + geo identity.
 *
 * Two judgement calls live here, both of the form *assert nothing rather than assert wrong*:
 *
 * **A caller-supplied proxy suppresses the geo assertion.** Egress then leaves through someone
 * else's exit IP, and a host-derived `en-US` / `America/Toronto` story over a German exit is the
 * textbook incoherence — measurably worse than the honest baseline, because asserting nothing
 * leaves the browser's own values in place while asserting wrong manufactures a contradiction. The
 * session still gets its display fingerprint (screen geometry has nothing to do with egress) and
 * the operator gets a warning. If they supplied `timezoneId` themselves they have told us the
 * truth, so the seed is honoured and no warning fires.
 *
 * **A headful session gets no display assertion.** The window is genuinely on screen at its real
 * size; claiming a different one contradicts what the operator can see in the live view, and
 * `outerHeight` would disagree with the actual window. Headful sessions keep the geo half.
 */
export async function resolveIdentity(
  request: IdentityRequest,
  deps: IdentityResolverDeps,
): Promise<ResolvedIdentity> {
  const warnings: LaunchWarning[] = [];
  // Rule 1: the caller's own locale/timezone is the truth (missing half from the host, no warning).
  const hostSeed = resolveHostGeoSeed({ env: deps.host.env });
  const callerGeo = callerGeoSeed(request.contextOptions, hostSeed);
  const byoProxy = byoProxyPresent(request.launchOptions, request.contextOptions, request.proxy);

  let geo: GeoSeed | null = null;
  if (callerGeo !== null) {
    // The caller stated their own locale/timezone, so that is the truth — and it must feed the
    // WHOLE story, not just the half Playwright applies. Their `locale`/`timezoneId` win on the
    // context regardless (contextOptions are spread last), while `Accept-Language` and
    // `navigator.languages` come from this seed via the CDP override; resolving the *host* seed
    // here would ship a Berlin clock with host languages — the exact contradiction the BYO-proxy
    // rule exists to prevent, with the warning suppressed.
    geo = callerGeo;
  } else if (!byoProxy) {
    // Rule 3: the host (or, later, proxy-exit) resolver, per session.
    geo = await deps.geoSeed.resolve({
      sessionId: request.sessionId,
      ...(request.proxy !== null && { proxyServer: request.proxy.server }),
    });
  } else {
    // Rule 2: BYO proxy ⇒ display-only.
    warnings.push({
      code: 'BYO_PROXY_UNSEEDED',
      message:
        'a caller-supplied proxy changes the egress IP, so no locale/timezone identity was ' +
        'asserted (a host-derived one over a foreign exit is worse than none); pass ' +
        'context_options.timezoneId and .locale matching the proxy exit to assert one',
      details: { fingerprint: 'display-only' },
    });
  }

  // Rule 4: restore the display seed from the saved profile, so the same machine comes back with
  // the same cookies. A fresh identity against an existing cookie jar is itself a signal.
  const seed = request.restoredSeed ?? request.sessionId;
  const fingerprint = deriveFingerprint({ seed, hostPlatform: deps.host.platform });

  // Rule 5: a caller-supplied viewport wins on the context (contextOptions are spread last), but the
  // screen/window metrics the init script asserts are derived from *our* display — so a caller
  // viewport taller than that display produces an inner window larger than the monitor it sits on.
  // Same rule as the BYO proxy: stand down rather than assert a contradiction.
  const callerViewport = request.contextOptions?.viewport !== undefined;
  if (callerViewport) {
    warnings.push({
      code: 'VIEWPORT_OVERRIDE_UNASSERTED',
      message:
        'context_options.viewport overrides the presented display, so no screen/window geometry ' +
        'was asserted (a viewport larger than the asserted screen is an impossible machine); ' +
        'drop the viewport to get a coherent per-session display',
      details: { fingerprint: 'geo-only' },
    });
  }

  // Headful: keep the geo half, drop the display half (see the doc comment above).
  return {
    identity: { fingerprint, geo, assertDisplay: request.headless && !callerViewport },
    warnings,
  };
}
