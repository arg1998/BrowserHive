/** @module browserhive/testing — the type of the internal testing seam of `createServer` (spec 08 §9, spec 13 §14) for BrowserHive's own suites. Importing it throws unless the environment sets `BHDEV_TESTING=1` (D-63). @internal */

import { TESTING_ENV, testingEnabled, testingRefusedMessage } from './composition/testing-seam.ts';

if (!testingEnabled()) {
  throw new Error(testingRefusedMessage(`'browserhive/testing'`));
}

export type { ServerTesting } from './composition/testing-seam.ts';
/** The variable the seam requires (`BHDEV_TESTING=1`). @internal */
export { TESTING_ENV };
