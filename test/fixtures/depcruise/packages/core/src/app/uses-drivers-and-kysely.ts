/** @module test/fixtures/depcruise/app — breaks `playwright-only-in-browsers` and `sqlite-only-in-persistence`. */
import { Kysely } from 'kysely';
import { chromium } from 'patchright-core';

/** Uses the imports so the fixture type-checks. */
export const used = [Kysely, chromium] as const;
