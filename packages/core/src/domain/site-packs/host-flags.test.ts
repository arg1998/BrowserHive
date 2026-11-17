/** @module domain/site-packs/host-flags.test — `webrtc-policy`'s switches come from the compiled-in table and the strictest policy wins (spec 13 §9.4, §9.10). */

import { describe, expect, test } from 'bun:test';
import {
  hostFlagsOf,
  sameHostFlags,
  strictestWebRtcPolicy,
  WEBRTC_POLICY_FLAGS,
  webrtcPolicyOfFlags,
} from './host-flags.ts';

describe('host flags', () => {
  test('the strictest policy wins; none selects none', () => {
    expect(strictestWebRtcPolicy([])).toBeNull();
    expect(strictestWebRtcPolicy(['default_public_interface_only'])).toBe(
      'default_public_interface_only',
    );
    expect(
      strictestWebRtcPolicy([
        'default_public_interface_only',
        'disable_non_proxied_udp',
        'default_public_interface_only',
      ]),
    ).toBe('disable_non_proxied_udp');
  });

  test('the switches are the table entries, one per policy', () => {
    expect(hostFlagsOf(null)).toEqual([]);
    expect(hostFlagsOf('disable_non_proxied_udp')).toEqual([
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]);
    for (const flag of Object.values(WEBRTC_POLICY_FLAGS)) {
      expect(flag).toMatch(/^--force-webrtc-ip-handling-policy=[a-z_]+$/);
    }
  });

  test('flag sets compare without order', () => {
    expect(sameHostFlags([], [])).toBe(true);
    expect(sameHostFlags(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameHostFlags(['a'], [])).toBe(false);
    expect(sameHostFlags(['a'], ['b'])).toBe(false);
  });

  test('the policy a flag set carries (the profile preference follows it)', () => {
    expect(webrtcPolicyOfFlags([])).toBeNull();
    expect(webrtcPolicyOfFlags(['--disable-sync'])).toBeNull();
    expect(webrtcPolicyOfFlags(hostFlagsOf('default_public_interface_only'))).toBe(
      'default_public_interface_only',
    );
    expect(webrtcPolicyOfFlags(['--force-webrtc-ip-handling-policy=default'])).toBeNull();
  });
});
