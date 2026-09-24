/** @module infra/browsers/sandbox — Chromium sandbox facts: recognising a sandbox launch failure and Chrome's own reason, the host conditions that decide it (AppArmor, user namespaces, root, containers), the one-launch probe, and the AppArmor profile text (plan §3.4). */

import type { BrowserType, LaunchOptions } from 'playwright';

/**
 * Chrome's and Playwright's markers of a sandbox that could not start. Playwright rewrites the first
 * three into "Chromium sandboxing failed!"; the namespace and zygote lines are what Chrome prints
 * under Docker's default seccomp profile, and the SUID lines what Microsoft Edge prints on Ubuntu
 * 23.10+; Playwright rewrites neither. Anything else is proven by an unsandboxed launch instead.
 */
const SANDBOX_FAILURE_RE =
  /Chromium sandboxing failed!|No usable sandbox|crbug\.com\/638180|crbug\.com\/357670|Failed to move to new namespace|zygote_host_impl_linux|setuid_sandbox_host|SUID sandbox helper|sandbox_linux|credentials\.cc/;

/** Whether a launch error says the sandbox could not start. */
export function isSandboxFailure(err: unknown): boolean {
  return err instanceof Error && SANDBOX_FAILURE_RE.test(err.message);
}

/** Chrome's sentences that name the cause, most specific first. */
const REASONS: readonly RegExp[] = [
  /No usable sandbox!/,
  /Running as root without --no-sandbox is not supported\./,
  /Failed to move to new namespace:[^\n]*/,
  // Microsoft Edge on Ubuntu 23.10+ (its helper is not setuid root, and user namespaces are restricted).
  /The SUID sandbox helper binary was found, but is not configured correctly\./,
];

/**
 * Chrome's own one-line reason out of a launch error, so nothing is guessed: a known sentence that
 * names the cause, else the first `FATAL`/`ERROR` log line without its `[pid:tid:…]` prefix, else
 * the first line of the message.
 *
 * @returns E.g. `No usable sandbox!` or `Running as root without --no-sandbox is not supported.`
 */
export function sandboxFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  for (const re of REASONS) {
    const found = re.exec(message)?.[0]?.trim();
    if (found !== undefined && found !== '') return clip(found);
  }
  for (const line of message.split('\n')) {
    const logged = /:(?:FATAL|ERROR):[^\]]*\]\s*(.+)$/.exec(line)?.[1]?.trim();
    if (logged !== undefined && logged !== '') return firstSentence(logged);
  }
  const first = message.split('\n').find((l) => l.trim() !== '') ?? 'the browser did not start';
  return firstSentence(first.trim());
}

function clip(text: string): string {
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function firstSentence(text: string): string {
  const end = /[.!](\s|$)/.exec(text);
  return clip(end === null ? text : text.slice(0, end.index + 1));
}

/** Host conditions that decide whether Chromium's sandbox can start. */
export interface SandboxEnvironment {
  readonly platform: string;
  /** `PRETTY_NAME` of `/etc/os-release` on Linux, else null. */
  readonly distro: string | null;
  /** Running as uid 0 (Chrome refuses to sandbox as root). */
  readonly root: boolean;
  /** Inside a container (Docker/Podman markers or a container cgroup). */
  readonly container: boolean;
  /** `kernel.apparmor_restrict_unprivileged_userns=1` (Ubuntu 23.10+ and derivatives). */
  readonly apparmorRestrictsUserns: boolean;
  /** `kernel.unprivileged_userns_clone=0` (older Debian kernels). */
  readonly usernsCloneDisabled: boolean;
  /** `user.max_user_namespaces=0`. */
  readonly userNamespacesDisabled: boolean;
}

/** Filesystem and process facts {@link inspectSandboxEnvironment} reads (tests pass fakes). */
export interface SandboxEnvironmentDeps {
  readonly platform: string;
  readonly uid: number | null;
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string | null;
}

function sysctl(deps: SandboxEnvironmentDeps, path: string): string | null {
  return deps.readFile(path)?.trim() ?? null;
}

/** Reads the host conditions of {@link SandboxEnvironment}. Never throws. */
export function inspectSandboxEnvironment(deps: SandboxEnvironmentDeps): SandboxEnvironment {
  const linux = deps.platform === 'linux';
  const osRelease = linux ? deps.readFile('/etc/os-release') : null;
  const pretty = osRelease === null ? null : /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease)?.[1];
  const cgroup = linux ? (deps.readFile('/proc/1/cgroup') ?? '') : '';
  return {
    platform: deps.platform,
    distro: pretty ?? null,
    root: deps.uid === 0,
    container:
      linux &&
      (deps.exists('/.dockerenv') ||
        deps.exists('/run/.containerenv') ||
        /docker|kubepods|containerd|libpod/.test(cgroup)),
    apparmorRestrictsUserns:
      linux && sysctl(deps, '/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1',
    usernsCloneDisabled:
      linux && sysctl(deps, '/proc/sys/kernel/unprivileged_userns_clone') === '0',
    userNamespacesDisabled: linux && sysctl(deps, '/proc/sys/user/max_user_namespaces') === '0',
  };
}

/** Directory of AppArmor profiles on Linux. */
export const APPARMOR_DIR = '/etc/apparmor.d';

/**
 * Whether an installed AppArmor profile names `executablePath` (Ubuntu ships them for
 * `/opt/google/chrome/chrome`, `msedge`, `brave`, `opera`; none for Playwright's download path).
 *
 * @returns true/false, or null when not on Linux or the profile directory cannot be read.
 */
export function apparmorProfileCovers(
  executablePath: string,
  deps: {
    readonly platform: string;
    readonly listDir: (path: string) => readonly string[];
    readonly readFile: (path: string) => string | null;
  },
): boolean | null {
  if (deps.platform !== 'linux') return null;
  const names = deps.listDir(APPARMOR_DIR);
  if (names.length === 0) return null;
  for (const name of names) {
    const text = deps.readFile(`${APPARMOR_DIR}/${name}`);
    if (text?.includes(executablePath) === true) return true;
  }
  return false;
}

/** The AppArmor profile name BrowserHive suggests for the bundled browser. */
export const APPARMOR_PROFILE_NAME = 'browserhive-chromium';

/**
 * An AppArmor profile that lets one browser binary create user namespaces, in the same shape as the
 * profiles Ubuntu ships for Google Chrome (`/etc/apparmor.d/chrome`). BrowserHive only prints it; the
 * operator installs it with `sudo`.
 *
 * @returns The profile text, ending with a newline.
 */
export function apparmorProfile(executablePath: string, name = APPARMOR_PROFILE_NAME): string {
  return [
    '# Lets the browser BrowserHive downloads create the user namespaces Chromium sandboxes with.',
    "# Written by `browserhive doctor --printApparmorProfile`; like Ubuntu's own profile for",
    '# /opt/google/chrome/chrome, it allows everything and only gives the binary a name.',
    '# Redo it after a BrowserHive update that downloads a new browser build (the path changes).',
    '',
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile ${name} ${/\s/.test(executablePath) ? `"${executablePath}"` : executablePath} flags=(unconfined) {`,
    '  userns,',
    '',
    '  # Site-specific additions and overrides. See local/README for details.',
    `  include if exists <local/${name}>`,
    '}',
    '',
  ].join('\n');
}

/** Outcome of probing one browser with the sandbox forced on. */
export type SandboxProbeResult =
  | { readonly state: 'works'; readonly version: string }
  | { readonly state: 'unavailable'; readonly reason: string }
  | { readonly state: 'not-installed' }
  | { readonly state: 'broken'; readonly reason: string };

/** What to probe: a channel's Playwright name, optionally with an explicit binary. */
export interface SandboxProbeTarget {
  /** Playwright `channel` (`chromium`, `chrome`, `msedge`). */
  readonly playwrightChannel: string;
  readonly executablePath?: string;
}

const MISSING_BINARY_RE =
  /Executable doesn't exist at|Chromium distribution '[\w-]+' is not found|Failed to launch: .*ENOENT/;

/** Probe launch ceiling. */
export const SANDBOX_PROBE_TIMEOUT_MS = 30_000;

/**
 * Launches the browser once, headless, with the sandbox forced on. When that fails, it launches again
 * without the sandbox: only if the second launch works is the sandbox the cause (`unavailable`), so a
 * browser that is broken for another reason is never blamed on the sandbox (`broken`).
 *
 * @returns The verdict; never throws.
 */
export async function probeSandbox(
  browserType: Pick<BrowserType, 'launch'>,
  target: SandboxProbeTarget,
  timeoutMs = SANDBOX_PROBE_TIMEOUT_MS,
): Promise<SandboxProbeResult> {
  const base: LaunchOptions = {
    headless: true,
    timeout: timeoutMs,
    ...(target.executablePath === undefined
      ? { channel: target.playwrightChannel }
      : { executablePath: target.executablePath }),
  };
  let sandboxError: unknown;
  try {
    const browser = await browserType.launch({ ...base, chromiumSandbox: true });
    const version = browser.version();
    await browser.close().catch(() => undefined);
    return { state: 'works', version };
  } catch (err) {
    if (err instanceof Error && MISSING_BINARY_RE.test(err.message)) {
      return { state: 'not-installed' };
    }
    sandboxError = err;
  }
  try {
    const browser = await browserType.launch({ ...base, chromiumSandbox: false });
    await browser.close().catch(() => undefined);
    return { state: 'unavailable', reason: sandboxFailureReason(sandboxError) };
  } catch (err) {
    return { state: 'broken', reason: sandboxFailureReason(err) };
  }
}
