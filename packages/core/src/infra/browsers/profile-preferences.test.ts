/** @module infra/browsers/profile-preferences.test — the `webrtc-policy` preference (spec 13 §9.4): set at a start with a policy, removed at a start without one, other preferences untouched. */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTemplatePreferences, withWebRtcPolicy } from './profile-preferences.ts';

describe('WebRTC policy preference', () => {
  it('sets and removes webrtc.ip_handling_policy, keeping the rest', () => {
    const base = { webrtc: { other: 1 }, signin: { allowed: false } };
    const set = withWebRtcPolicy(base, 'disable_non_proxied_udp');
    expect(set).toEqual({
      webrtc: { other: 1, ip_handling_policy: 'disable_non_proxied_udp' },
      signin: { allowed: false },
    });
    expect(withWebRtcPolicy(set, null)).toEqual(base);
    expect(withWebRtcPolicy({ a: 1 }, null)).toEqual({ a: 1 });
  });

  it('a host start writes it, a later start without a policy removes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-prefs-'));
    try {
      const read = () => JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'));
      await applyTemplatePreferences(dir, { webrtcPolicy: 'default_public_interface_only' });
      expect(read().webrtc).toEqual({ ip_handling_policy: 'default_public_interface_only' });
      await applyTemplatePreferences(dir);
      expect(read().webrtc).toEqual({ ip_handling_policy: 'default_public_interface_only' });
      await applyTemplatePreferences(dir, { webrtcPolicy: null });
      expect(read().webrtc).toEqual({});
      expect(read().signin).toEqual({ allowed: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
