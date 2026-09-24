/** @module test/helpers/integration-channel — the browser channel the real-browser suites launch: the bundled `chromium`, or the installed Google Chrome when the weekly drift job sets `BHDEV_TEST_CHANNEL=chrome` (spec 06 §5). */

/**
 * The channel integration suites use for sessions that do not test a channel on purpose.
 *
 * @returns `chrome` under `BHDEV_TEST_CHANNEL=chrome`, else `chromium`.
 */
export function integrationChannel(): 'chromium' | 'chrome' {
  return process.env['BHDEV_TEST_CHANNEL'] === 'chrome' ? 'chrome' : 'chromium';
}
