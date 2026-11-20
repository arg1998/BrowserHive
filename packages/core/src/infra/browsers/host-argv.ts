/** @module infra/browsers/host-argv — the command line of a template host that starts with no window (spec 13 §3.1, §3.10, D-78): Patchright's own default argv for the same options, with its first page (`about:blank`) swapped for `--no-startup-window`, and the fail-closed check that the proxy, the sandbox setting and the required switches are on it before the browser starts. */

import { createRequire } from 'node:module';
import type { LaunchOptions } from 'patchright';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { ProxySpec } from '../../ports/browser-driver.ts';

/** The switch that starts Chromium with no window; the pipe's keep-alive then holds the browser. */
export const NO_STARTUP_WINDOW = '--no-startup-window';

/**
 * Switches every host's command line MUST carry (spec 13 §3.10): the three that keep background
 * windows running, the pipe Patchright drives the browser through, and `--no-startup-window`.
 */
export const REQUIRED_HOST_SWITCHES: readonly string[] = Object.freeze([
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--remote-debugging-pipe',
  NO_STARTUP_WINDOW,
]);

/** Switches that send requests around a configured proxy (refused when the template has one). */
export const PROXY_OVERRIDES: readonly string[] = Object.freeze([
  '--no-proxy-server',
  '--proxy-pac-url',
  '--proxy-auto-detect',
  '--winhttp-proxy-resolver',
]);

/** Switches that open a DevTools endpoint besides the pipe (refused on every host). */
export const DEBUGGING_OVERRIDES: readonly string[] = Object.freeze([
  '--remote-debugging-port',
  '--remote-debugging-address',
]);

/** The first page a persistent launch opens (Patchright's `defaultArgs`, persistent only). */
const FIRST_PAGE = 'about:blank';

/** Patchright's server-side argv builder, `chromium.defaultArgs(options, isPersistent, userDataDir)`. */
type DefaultArgs = (
  options: Record<string, unknown>,
  isPersistent: boolean,
  userDataDir: string,
) => Promise<unknown>;

let builder: DefaultArgs | null | undefined;

/**
 * The driver's own argv builder, through the exported `patchright-core/lib/coreBundle` subpath
 * (`server.createPlaywright(...).chromium.defaultArgs`, the code a normal launch runs). `null` when
 * this driver build does not have it (a Patchright bump moved it): the host start then fails.
 */
export function driverDefaultArgs(): DefaultArgs | null {
  if (builder !== undefined) return builder;
  builder = null;
  try {
    const require = createRequire(import.meta.url);
    const server = member(require('patchright-core/lib/coreBundle'), 'server');
    const create = member(server, 'createPlaywright');
    if (typeof create !== 'function') return null;
    const playwright: unknown = create.call(server, { sdkLanguage: 'javascript' });
    const chromium = member(playwright, 'chromium');
    const defaultArgs = member(chromium, 'defaultArgs');
    if (typeof defaultArgs !== 'function') return null;
    builder = (options, isPersistent, userDataDir) =>
      Promise.resolve(defaultArgs.call(chromium, options, isPersistent, userDataDir));
  } catch {
    builder = null;
  }
  return builder;
}

/**
 * The options as the driver's server sees them before it builds the argv (its
 * `_validateLaunchOptions` and `normalizeProxySettings`): `headless` defaults to `true`, and the
 * proxy server is reduced to `scheme://host:port` (a bare `host:port` means `http://`).
 */
export function serverLaunchOptions(options: LaunchOptions): Record<string, unknown> {
  const { proxy, ignoreDefaultArgs: _ignored, ...rest } = options;
  return {
    ...rest,
    headless: options.headless ?? true,
    ...(proxy !== undefined && { proxy: { ...proxy, server: normalizeProxyServer(proxy.server) } }),
  };
}

/** `normalizeProxySettings` of the driver's server for the `server` field. */
export function normalizeProxyServer(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
    if (url.host === '' || url.protocol === '') url = new URL(`http://${server}`);
  } catch {
    url = new URL(`http://${server}`);
  }
  return `${url.protocol}//${url.host}`;
}

/** What {@link hostArgv} checks the argv against. */
export interface HostArgvFacts {
  /** The template's pinned proxy (`null`: the machine's own IP). */
  readonly proxy: ProxySpec | null;
  /** The sandbox attempt this argv is for (`chromiumSandbox: true`). */
  readonly sandboxed: boolean;
}

/**
 * The host's full command line for `launchPersistentContext(userDataDir, {...options,
 * ignoreDefaultArgs: true, args})`: what Patchright would launch with for `options` (its 30-odd
 * switches, `--no-sandbox` unless sandboxed, the proxy switches, BrowserHive's `args`,
 * `--user-data-dir` and the pipe), minus the switches `options.ignoreDefaultArgs` removes, with the
 * first page `about:blank` replaced by `--no-startup-window`.
 *
 * Fail closed (spec 13 §3.10, D-78): with `ignoreDefaultArgs: true` the driver adds nothing of its
 * own, so a template whose argv lacked its proxy switch would send every request from the
 * machine's own IP. The start is refused (`INTERNAL_ERROR`, `ref: 'launch_args'`, the host goes
 * `failed` with `TEMPLATE_HOST_FAILED` `reason: 'launch_args'`) when the builder is missing, when
 * the proxy switch for the template's proxy is absent or repeated, when a switch overrides the
 * proxy (`--no-proxy-server`, a PAC URL, auto-detection, a second SOCKS resolver rule), when a
 * DevTools port is opened, when `--no-sandbox` disagrees with the sandbox attempt, when a required
 * switch is missing, or when `--user-data-dir` or the pipe is repeated.
 */
export async function hostArgv(
  options: LaunchOptions,
  userDataDir: string,
  facts: HostArgvFacts,
): Promise<string[]> {
  const build = driverDefaultArgs();
  if (build === null) throw argvRefused('the driver has no argv builder (Patchright changed)');
  const ignored = Array.isArray(options.ignoreDefaultArgs) ? options.ignoreDefaultArgs : [];
  const derived: unknown = await build(serverLaunchOptions(options), true, userDataDir);
  if (!Array.isArray(derived) || !derived.every((arg) => typeof arg === 'string')) {
    throw argvRefused('the driver returned no argv');
  }
  const argv = [
    ...(derived as string[]).filter((arg) => arg !== FIRST_PAGE && !ignored.includes(arg)),
    NO_STARTUP_WINDOW,
  ];
  assertHostArgv(argv, userDataDir, facts);
  return argv;
}

/** The checks of {@link hostArgv}; throws the refusal naming the first problem found. */
export function assertHostArgv(
  argv: readonly string[],
  userDataDir: string,
  facts: HostArgvFacts,
): void {
  // Chromium honours a switch with one leading dash too (`-no-proxy-server`, measured): every
  // check reads the argv with such a switch spelled with two (verify #91 N4).
  const spelled = argv.map((arg) => (/^-[^-]/.test(arg) ? `-${arg}` : arg));
  const named = (name: string) =>
    spelled.filter((arg) => arg === name || arg.startsWith(`${name}=`));
  if (facts.proxy !== null) {
    const expected = `--proxy-server=${normalizeProxyServer(facts.proxy.server)}`;
    const servers = named('--proxy-server');
    if (!servers.includes(expected)) throw argvRefused('the proxy switch is missing');
    // Chromium keeps the last of a repeated switch: exactly one, the template's.
    if (servers.length !== 1) throw argvRefused('the proxy switch is repeated');
    for (const bypass of PROXY_OVERRIDES) {
      if (named(bypass).length > 0) throw argvRefused(`${bypass} overrides the proxy`);
    }
    // Patchright's SOCKS rule keeps DNS on the proxy; a second rule would replace it.
    if (expected.startsWith('--proxy-server=socks') && named('--host-resolver-rules').length > 1) {
      throw argvRefused('a second --host-resolver-rules replaces the SOCKS DNS rule');
    }
  } else if (named('--proxy-server').length > 0) {
    throw argvRefused('a proxy switch is present for a template without a proxy');
  }
  if (named('--proxy-bypass-list').length > 1) throw argvRefused('the proxy bypass is repeated');
  for (const forbidden of DEBUGGING_OVERRIDES) {
    if (named(forbidden).length > 0) throw argvRefused(`${forbidden} opens another DevTools door`);
  }
  for (const once of ['--user-data-dir', '--remote-debugging-pipe']) {
    if (named(once).length > 1) throw argvRefused(`${once} is repeated`);
  }
  if (spelled.includes('--no-sandbox') === facts.sandboxed) {
    throw argvRefused(
      facts.sandboxed ? '--no-sandbox is present on a sandboxed start' : '--no-sandbox is missing',
    );
  }
  for (const required of REQUIRED_HOST_SWITCHES) {
    if (!spelled.includes(required)) throw argvRefused(`${required} is missing`);
  }
  if (!spelled.includes(`--user-data-dir=${userDataDir}`)) {
    throw argvRefused('--user-data-dir is missing');
  }
  if (argv.some((arg) => !arg.startsWith('-'))) {
    throw argvRefused('the argv opens a page');
  }
}

/** The refusal of a host start whose command line is not the one it must be. */
function argvRefused(problem: string): AppError<'INTERNAL_ERROR'> {
  return new AppError(
    'INTERNAL_ERROR',
    { ref: 'launch_args' },
    { message: `template host not started: its browser command line is unsafe (${problem})` },
  );
}

function member(value: unknown, key: string): unknown {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    ? Reflect.get(value, key)
    : undefined;
}
