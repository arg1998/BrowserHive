/** @module test/fixtures/depcruise/interface — breaks `interface-no-playwright` twice (both drivers). */

import type { BrowserContext as PatchrightContext } from 'patchright-core';
import type { BrowserContext } from 'playwright';

/** Uses the imports so the fixture type-checks. */
export type Contexts = [BrowserContext, PatchrightContext];
