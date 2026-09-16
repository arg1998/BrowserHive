/** @module test/preload — global test preload for `bun test` (unit suites). */
process.env['TZ'] = 'UTC';

/**
 * Dashboard suites need the happy-dom globals before any module is linked. Bun evaluates CommonJS
 * dependencies (react-dom, Testing Library) while linking a test file, i.e. before that file's own
 * `import '../setup.ts'` runs; react-dom then caches "no DOM" for the whole process, and every later
 * file's portals, toasts and popups fail depending on which file happened to load first. Registering
 * here, before the first file links, makes the order irrelevant. Server suites never get a DOM.
 */
if (process.argv.some((arg) => arg.includes('packages/dashboard'))) {
  const dashboardSetup = '../packages/dashboard/test/setup.ts';
  await import(dashboardSetup);
  // Unmount after every test in every file (a hook in a shared helper module binds only to the first
  // file that imports it). Trees left mounted keep ticking clocks and timers into the next test,
  // which is where the "not wrapped in act(...)" noise came from.
  const { afterEach } = await import('bun:test');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());
}

export {};
