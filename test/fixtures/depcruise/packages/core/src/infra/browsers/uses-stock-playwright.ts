/** @module test/fixtures/depcruise/infra/browsers — breaks `no-stock-playwright` where drivers are otherwise allowed (D-65). */
import { chromium } from 'playwright-core';

/** Uses the import so the fixture type-checks. */
export const used = chromium;
