/** @module features/templates/wizard/identity-defaults.test — step 3's server defaults: Agent windows follow the server's `headedWindows` setting (D-77), minimized when it is unknown, and the default option is marked. */
import { describe, expect, it } from 'bun:test';
import type { SystemInfo } from '@browserhive/contracts/http';
import { agentWindowsOptions, identityDefaults } from './identity-defaults.ts';

describe('Agent windows defaults (D-77)', () => {
  it("take the server's headedWindows, minimized while /system is unknown", () => {
    expect(identityDefaults(undefined, null, 'en').agentWindows).toBe('minimized');
    const system = {
      browser: { headed_windows: 'normal', channels: [] },
      stealth: {},
    } as unknown as SystemInfo;
    expect(identityDefaults(system, null, 'en').agentWindows).toBe('normal');
  });

  it('mark the default option and list Minimized first', () => {
    expect(agentWindowsOptions('minimized')).toEqual([
      { value: 'minimized', label: 'Minimized (default)' },
      { value: 'normal', label: 'Normal' },
    ]);
    expect(agentWindowsOptions('normal').map((o) => o.label)).toEqual([
      'Minimized',
      'Normal (default)',
    ]);
  });
});
