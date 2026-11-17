/** @module domain/site-packs/host-flags — the Chromium switches a pack strategy may add to a template host's command line (spec 13 §9.4 `webrtc-policy`, §9.10): only from this compiled-in table, never from pack data. */

import type { WebRtcPolicy } from './strategy-specs.ts';

/** The switch of each WebRTC IP handling policy. */
export const WEBRTC_POLICY_FLAGS: { readonly [P in WebRtcPolicy]: string } = Object.freeze({
  default_public_interface_only: '--force-webrtc-ip-handling-policy=default_public_interface_only',
  disable_non_proxied_udp: '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
});

/**
 * The profile preference that carries the same policy (`webrtc.ip_handling_policy`): measured on
 * Chromium 153, the full browser (every template host's) ignores the switch and honours only this
 * preference, while the headless shell honours only the switch; a host gets both.
 */
export const WEBRTC_POLICY_PREFERENCE = Object.freeze({
  section: 'webrtc',
  key: 'ip_handling_policy',
} as const);

/** The policies from loosest to strictest. */
const STRICTNESS: readonly WebRtcPolicy[] = [
  'default_public_interface_only',
  'disable_non_proxied_udp',
];

/** The strictest of the policies the template's enabled sites select; `null` when none does. */
export function strictestWebRtcPolicy(policies: readonly WebRtcPolicy[]): WebRtcPolicy | null {
  let best: WebRtcPolicy | null = null;
  for (const policy of policies) {
    if (best === null || STRICTNESS.indexOf(policy) > STRICTNESS.indexOf(best)) best = policy;
  }
  return best;
}

/** The host switches for a WebRTC policy (none without one). */
export function hostFlagsOf(policy: WebRtcPolicy | null): readonly string[] {
  return policy === null ? [] : [WEBRTC_POLICY_FLAGS[policy]];
}

/** True when two flag sets are equal (order ignored). */
export function sameHostFlags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((flag, i) => flag === right[i]);
}

/** The WebRTC policy a flag set carries (the one from {@link WEBRTC_POLICY_FLAGS}), or `null`. */
export function webrtcPolicyOfFlags(flags: readonly string[]): WebRtcPolicy | null {
  let found: WebRtcPolicy | null = null;
  for (const policy of STRICTNESS) {
    if (flags.includes(WEBRTC_POLICY_FLAGS[policy])) found = policy;
  }
  return found;
}
