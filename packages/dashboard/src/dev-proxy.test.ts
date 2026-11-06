/** @module dev-proxy.test — the dev server proxies exactly the daemon's reserved prefixes (04 §18.10); the literal list keeps `vite.config.ts` free of workspace imports. */
import { describe, expect, it } from 'bun:test';
import { NON_SPA_PREFIXES } from '@browserhive/contracts/paths';
import { PROXIED_PATHS } from './dev-proxy.ts';

describe('PROXIED_PATHS', () => {
  it('equals NON_SPA_PREFIXES', () => {
    expect([...PROXIED_PATHS]).toEqual([...NON_SPA_PREFIXES]);
  });
});
