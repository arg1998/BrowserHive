/**
 * @module scripts/test-integration — runs the real-browser suites (`bun run test:integration`) with a
 * per-test and per-hook limit, then any extra arguments (`-t name`, a file) as given.
 *
 * Bun's own default is 5 s, which a test that launches Chromium and a fixture server per test exceeds
 * on slower runners (macOS and Windows CI are 2–3× slower than Ubuntu, issues #23 and #26). On a
 * timeout Bun also kills the processes the test spawned, so one slow hook cascades into
 * `BROWSER_CRASHED` and `Target closed` failures in the tests after it. The limit is passed as
 * `--timeout`, because `setDefaultTimeout` in a preload only reaches the first test file (measured on
 * Bun 1.4.2). Tests that need longer still pass their own limit.
 */

/** Per-test and per-hook limit of the real-browser suites. */
export const INTEGRATION_TIMEOUT_MS = 30_000;

/** The directories of the real-browser suites. */
export const INTEGRATION_SUITES = [
  'packages/core/test/integration',
  'packages/browserhive/test/integration',
] as const;

/** `BHDEV_TEST_TIMEOUT_MS` overrides the limit (a slow local machine, a debugger session). */
export function integrationTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['BHDEV_TEST_TIMEOUT_MS'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : INTEGRATION_TIMEOUT_MS;
}

/** A file or directory argument (`packages/core/test/integration/vault.test.ts`), not a flag value. */
function isPathArg(arg: string): boolean {
  return !arg.startsWith('-') && (/[\\/]/.test(arg) || /\.tsx?$/.test(arg));
}

/**
 * The `bun test` argument list: preload, limit, one file at a time, then the suites (unless `extra`
 * names files or directories itself) and `extra`.
 */
export function integrationArgs(
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): string[] {
  return [
    'test',
    '--preload',
    './test/integration/preload.ts',
    '--timeout',
    String(integrationTimeoutMs(env)),
    '--max-concurrency=1',
    ...(extra.some(isPathArg) ? [] : INTEGRATION_SUITES),
    ...extra,
  ];
}

if (import.meta.main) {
  const child = Bun.spawn([process.execPath, ...integrationArgs(process.env, Bun.argv.slice(2))], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(await child.exited);
}
