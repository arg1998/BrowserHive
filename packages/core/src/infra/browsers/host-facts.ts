/** @module infra/browsers/host-facts — the slice of the injected HostEnvironment the browser adapter reads (never `process.env`/`os` directly). */

import type { HostEnvironment } from '../../ports/host-environment.ts';

/**
 * Host descriptors the stealth pipeline needs: `platform`/`arch`/`release` feed identity
 * derivation (UA-CH platform, architecture, `platformVersion`) and the display catalogue; `env`
 * feeds the geo seed (`LC_ALL`/`LANG`) and the Chromium resolver (`PLAYWRIGHT_BROWSERS_PATH`).
 */
export type HostFacts = Pick<HostEnvironment, 'platform' | 'arch' | 'release' | 'env'>;
