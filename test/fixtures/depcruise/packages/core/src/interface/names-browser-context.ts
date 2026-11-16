/** @module test/fixtures/depcruise/interface — breaks `interface-no-playwright` twice (the driver and its core package). */

import type { BrowserContext } from 'patchright';
import type { BrowserContext as PatchrightContext } from 'patchright-core';

/** Uses the imports so the fixture type-checks. */
export type Contexts = [BrowserContext, PatchrightContext];
