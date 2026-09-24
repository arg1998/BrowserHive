/** @module cli/commands/init-browser — the `init` browser step: detection report, the interactive default-browser menu with pros and cons computed for this host, the optional Google Chrome install, and saving `defaultChannel` to the config file (plan §3.1, §3.2, §7) */
import { join } from 'node:path';
import type { Channel } from '@browserhive/contracts/enums';
import type { ResolvedConfigBundle } from '@browserhive/core/config';
import type {
  DetectedBrowser,
  SandboxEnvironment,
  SandboxProbeResult,
} from '@browserhive/core/server';
import type { CommandContext } from '../deps.ts';
import type { SandboxMode } from './doctor-browsers.ts';

/** Ceiling of Google's installer (download plus package manager). */
const CHROME_INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Config file created in the data dir when none is in use (the last discovery candidate, spec 08 §3). */
export const CONFIG_FILE = 'browserhive.config.json';

/** Options of the browser step. */
export interface BrowserChoiceOptions {
  readonly resolved: ResolvedConfigBundle;
  /** `--channel`: select (and save) this channel without a menu. */
  readonly channel: Channel | null;
  /** `--installChrome`: run Google's installer through Playwright. */
  readonly installChrome: boolean;
  /** `--yes`: accept the save without a prompt. */
  readonly yes: boolean;
  readonly sandbox: SandboxMode;
}

/** What detection and probing found. */
export interface HostBrowsers {
  readonly browsers: readonly DetectedBrowser[];
  readonly sandbox: ReadonlyMap<Channel, SandboxProbeResult>;
  readonly environment: SandboxEnvironment;
}

/** One menu entry. */
export interface MenuEntry {
  readonly kind: 'channel' | 'install-chrome';
  readonly channel: Channel;
  readonly title: string;
  readonly tag: string | null;
  readonly pros: readonly string[];
  readonly cons: readonly string[];
}

function major(version: string | null): number | null {
  const head = version?.split('.')[0];
  return head === undefined ? null : Number.parseInt(head, 10);
}

/** Why the sandbox fails here, in a few words (`AppArmor`, `running as root`). */
export function shortSandboxCause(environment: SandboxEnvironment): string {
  if (environment.root) return 'running as root';
  if (environment.apparmorRestrictsUserns) return 'AppArmor';
  if (environment.usernsCloneDisabled || environment.userNamespacesDisabled) {
    return 'user namespaces disabled';
  }
  if (environment.container) return 'container seccomp';
  return 'sandbox failed';
}

/** Whether Playwright can install Google Chrome on this host (no Linux arm64 build exists). */
export function chromeInstallable(platform: string, arch: string): boolean {
  if (platform === 'linux') return arch === 'x64';
  return platform === 'darwin' || platform === 'win32';
}

/** Adds the channel's sandbox verdict on this machine to its pros or cons. */
function addSandboxLine(
  host: HostBrowsers,
  channel: Channel,
  pros: string[],
  cons: string[],
): void {
  if (host.environment.root) {
    cons.push('Runs without the sandbox here: Chrome refuses the sandbox as root');
    return;
  }
  const verdict = host.sandbox.get(channel);
  if (verdict?.state === 'works') {
    pros.push('Sandbox works on this machine');
  } else if (verdict?.state === 'unavailable') {
    cons.push(
      host.environment.apparmorRestrictsUserns && channel === 'chromium'
        ? 'Runs without the sandbox here unless you add an AppArmor profile'
        : `Cannot run sandboxed on this machine (${shortSandboxCause(host.environment)})`,
    );
  }
}

function policyCon(browser: DetectedBrowser): string {
  const { policies } = browser;
  if (policies.blocking.length > 0) {
    return `A managed policy here blocks automation (${policies.blocking.join(', ')})`;
  }
  if (policies.names.length > 0) {
    return `${policies.names.length} managed ${policies.names.length === 1 ? 'policy applies' : 'policies apply'} here; company policies can block automation`;
  }
  return 'On a company-managed machine, browser policies apply (can block automation)';
}

/**
 * The menu for this host: the installed channels, then "Install Google Chrome" when it is missing
 * and installable. Pros and cons are computed from what was detected, never a fixed essay.
 *
 * @returns The entries in display order.
 */
export function menuEntries(
  host: HostBrowsers,
  current: Channel,
  platform: { readonly platform: string; readonly arch: string },
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const bundled = host.browsers.find((b) => b.channel === 'chromium');
  const chrome = host.browsers.find((b) => b.channel === 'chrome');
  const pinned = major(bundled?.version ?? null);

  if (bundled !== undefined) {
    const pros = [
      'Same build everywhere; tested with this BrowserHive release',
      'Nothing to install; works in CI, Docker and without admin rights',
    ];
    const cons = [
      chrome?.installed === true && chrome.version !== null && chrome.version !== bundled.version
        ? `Reports its pinned full version (${bundled.version ?? '?'}); your Google Chrome is ${chrome.version}`
        : `Reports its pinned full version (${bundled.version ?? '?'}), a build real users may not run`,
    ];
    addSandboxLine(host, 'chromium', pros, cons);
    entries.push({
      kind: 'channel',
      channel: 'chromium',
      title: 'Chromium (bundled)',
      tag: null,
      pros,
      cons,
    });
  }

  for (const browser of host.browsers) {
    if (browser.source !== 'installed' || !browser.installed) continue;
    const pros = [
      browser.channel === 'chrome'
        ? 'The real browser at the version real users run; updates itself'
        : 'A real, self-updating browser',
    ];
    const cons: string[] = [];
    addSandboxLine(host, browser.channel, pros, cons);
    if (browser.channel === 'edge') {
      cons.push(
        'Under stealth BrowserHive presents it as Google Chrome while its user agent says Edge; sites can notice. Prefer Google Chrome for stealth',
      );
    }
    const ahead = major(browser.version);
    cons.push(
      pinned !== null && ahead !== null && ahead - pinned > 1
        ? `Already ${ahead - pinned} major versions ahead of what BrowserHive was tested with (${pinned})`
        : 'Updates on its own schedule: can get ahead of what BrowserHive was tested with',
    );
    cons.push(policyCon(browser));
    cons.push(
      `Persistent profiles made with a newer ${browser.label} may not open in Chromium later`,
    );
    entries.push({
      kind: 'channel',
      channel: browser.channel,
      title: `${browser.label} (installed${browser.version === null ? '' : ` ${browser.version}`})`,
      tag: browser.channel === 'chrome' ? 'recommended for stealth' : null,
      pros,
      cons,
    });
  }

  if (
    chrome !== undefined &&
    !chrome.installed &&
    chromeInstallable(platform.platform, platform.arch)
  ) {
    entries.push({
      kind: 'install-chrome',
      channel: 'chrome',
      title: 'Install Google Chrome (needs administrator rights)',
      tag: 'recommended for stealth',
      pros: ['The real browser at the version real users run; updates itself'],
      cons: [
        platform.platform === 'linux'
          ? "Runs Google's installer through 'playwright install chrome' (apt, with sudo)"
          : "Runs Google's installer through 'playwright install chrome'",
      ],
    });
  }
  return entries.map((entry) => ({
    ...entry,
    tag: entry.kind === 'channel' && entry.channel === current ? 'current' : entry.tag,
  }));
}

/** The menu as printed. */
export function renderMenu(entries: readonly MenuEntry[]): string[] {
  const lines = ['Which browser should sessions use by default?', ''];
  entries.forEach((entry, index) => {
    const head = `  ${index + 1}) ${entry.title}`;
    const tag = entry.tag === 'current' ? '← current' : (entry.tag ?? '');
    lines.push(tag === '' ? head : `${head.padEnd(58)}${tag}`);
    for (const pro of entry.pros) lines.push(`     + ${pro}`);
    for (const con of entry.cons) lines.push(`     − ${con}`);
    lines.push('');
  });
  return lines;
}

/** The sandbox summary line of the detection report (`chrome: works · chromium: unavailable here (AppArmor), falls back`). */
export function sandboxSummary(host: HostBrowsers, mode: SandboxMode): string {
  if (host.environment.root) {
    return 'running as root: Chrome refuses the sandbox, sessions run without it';
  }
  const parts: string[] = [];
  const order = [...host.sandbox.keys()].sort(
    (a, b) =>
      (host.sandbox.get(a)?.state === 'works' ? 0 : 1) -
      (host.sandbox.get(b)?.state === 'works' ? 0 : 1),
  );
  for (const channel of order) {
    const verdict = host.sandbox.get(channel);
    if (verdict === undefined || verdict.state === 'not-installed') continue;
    if (verdict.state === 'works') {
      parts.push(`${channel}: works`);
    } else if (verdict.state === 'unavailable') {
      const consequence =
        mode === 'auto' ? ', falls back' : mode === 'on' ? ', refuses (sandbox=on)' : '';
      parts.push(
        `${channel}: unavailable here (${shortSandboxCause(host.environment)})${consequence}`,
      );
    } else {
      parts.push(`${channel}: did not start`);
    }
  }
  return `${parts.join(' · ')}${mode === 'off' ? ' · sandbox=off' : ''}`;
}

/** Detects the channels and probes the sandbox of each installed one (skipped as root). */
export async function detectHostBrowsers(context: CommandContext): Promise<HostBrowsers> {
  const { probes } = context.deps;
  const [browsers, environment] = await Promise.all([
    probes.browsers(),
    probes.sandboxEnvironment(),
  ]);
  const sandbox = new Map<Channel, SandboxProbeResult>();
  if (!environment.root) {
    for (const browser of browsers) {
      if (browser.installed) sandbox.set(browser.channel, await probes.sandbox(browser.channel));
    }
  }
  return { browsers, sandbox, environment };
}

/** Prints the detection report (one line per channel and the sandbox summary). */
export function reportBrowsers(
  context: CommandContext,
  host: HostBrowsers,
  mode: SandboxMode,
): void {
  const { out } = context;
  for (const browser of host.browsers) {
    const label = browser.channel.padEnd(10);
    if (!browser.installed) {
      // Informational here: the download step above owns the ✗ for a missing bundled browser.
      out.status(
        browser.source === 'bundled' ? 'warn' : 'skip',
        label,
        browser.source === 'bundled' ? "not installed; run 'browserhive init'" : 'not installed',
      );
      continue;
    }
    const version = browser.version === null ? '' : ` ${browser.version}`;
    out.status(
      'ok',
      label,
      browser.source === 'bundled'
        ? `${browser.label}${version} (bundled, always kept)`
        : `${browser.label}${version} at ${browser.executablePath ?? '?'}`,
    );
  }
  const unavailable = [...host.sandbox.values()].some((v) => v.state === 'unavailable');
  out.status(
    host.environment.root || unavailable ? 'warn' : 'ok',
    'sandbox'.padEnd(10),
    sandboxSummary(host, mode),
  );
}

/** Whether `init` may ask questions: a terminal on stdin, and not CI or a container. */
export function interactive(context: CommandContext, host: HostBrowsers): boolean {
  const ci = context.deps.env['CI'];
  return (
    context.deps.prompt !== null &&
    (ci === undefined || ci === '' || ci === 'false' || ci === '0') &&
    !host.environment.container
  );
}

async function ask(context: CommandContext, question: string): Promise<string> {
  const prompt = context.deps.prompt;
  return prompt === null ? '' : (await prompt(question)).trim();
}

/**
 * Runs `playwright install chrome` (Google's official installer; needs administrator rights).
 *
 * @returns Whether Chrome is installed afterwards.
 */
async function installChrome(context: CommandContext): Promise<boolean> {
  const { deps, out } = context;
  const command = deps.probes.installCommand('playwright');
  if (command === null) {
    out.status(
      'fail',
      'Google Chrome',
      "cannot locate the Playwright CLI; run 'npx playwright install chrome'",
    );
    return false;
  }
  out.line(
    out.style.dim(
      '  installing Google Chrome (playwright install chrome; may ask for your password)…',
    ),
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(deps.env)) if (value !== undefined) env[name] = value;
  const outcome = await deps.runner
    .run(command.command, [...command.args, 'install', 'chrome'], {
      env,
      timeoutMs: CHROME_INSTALL_TIMEOUT_MS,
    })
    .then(
      (run) => ({ code: run.code, stderr: run.stderr }),
      (err: unknown) => ({
        code: null,
        stderr: err instanceof Error ? err.message : 'spawn failed',
      }),
    );
  const after = (await deps.probes.browsers()).find((b) => b.channel === 'chrome');
  if (outcome.code === 0 && after?.installed === true) {
    out.status(
      'ok',
      'Google Chrome',
      `installed${after.version === null ? '' : ` ${after.version}`}`,
    );
    return true;
  }
  const last = outcome.stderr.trim().split('\n').at(-1) ?? '';
  out.status(
    'fail',
    'Google Chrome',
    `install failed (exit ${outcome.code ?? 'signal'})${last === '' ? '' : `: ${last}`}`,
  );
  out.line(`  Retry with: ${out.style.bold('npx playwright install chrome')}`);
  return false;
}

/** Where the choice is saved: the config file in use, else `<dataDir>/browserhive.config.json`. */
export function configTarget(resolved: ResolvedConfigBundle): {
  readonly path: string;
  readonly exists: boolean;
} {
  const path = resolved.configFilePath;
  return path === undefined
    ? { path: join(resolved.config.dataDir, CONFIG_FILE), exists: false }
    : { path, exists: true };
}

/**
 * Merges `defaultChannel` into the config file without touching anything else (order, other keys and
 * `$schema` kept); creates the file (0600) when none exists.
 *
 * @returns An error sentence, or null when written.
 */
export async function saveDefaultChannel(
  context: CommandContext,
  target: { readonly path: string; readonly exists: boolean },
  channel: Channel,
): Promise<string | null> {
  const { fs } = context.deps;
  let data: Record<string, unknown> = {};
  if (target.exists) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(target.path));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return `${target.path} does not hold a JSON object; not changed`;
      }
      data = { ...parsed };
    } catch (err) {
      return `cannot read ${target.path}: ${err instanceof Error ? err.message : 'invalid JSON'}; not changed`;
    }
  }
  data['defaultChannel'] = channel;
  try {
    await fs.writeFile(target.path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    return null;
  } catch (err) {
    return `cannot write ${target.path}: ${err instanceof Error ? err.message : 'failed'}`;
  }
}

/** The variable the config file's `defaultChannel` reads through a reference (spec 08 §3.1), if any. */
function fileReference(resolved: ResolvedConfigBundle): string | undefined {
  const provenance = resolved.provenance.defaultChannel;
  const refs =
    provenance.source === 'file'
      ? provenance.refs
      : provenance.shadowed.find((value) => value.source === 'file')?.refs;
  return refs?.[0]?.ref;
}

/** A higher-precedence source (flag or env) that would override a saved file value. */
function overriddenBy(resolved: ResolvedConfigBundle): string | null {
  const source = resolved.provenance.defaultChannel.source;
  if (source === 'env') return 'BROWSERHIVE_DEFAULT_CHANNEL';
  if (source === 'cli') return '--defaultChannel';
  return null;
}

/**
 * The browser step of `init`: report, choose (menu, or `--channel`), optionally install Chrome, save.
 *
 * @returns false when a requested action failed (install, save, a missing channel).
 */
export async function stepBrowserChoice(
  context: CommandContext,
  options: BrowserChoiceOptions,
): Promise<boolean> {
  const { deps, out } = context;
  const current = options.resolved.config.defaultChannel;
  let host = await detectHostBrowsers(context);
  reportBrowsers(context, host, options.sandbox);

  if (options.installChrome) {
    const chrome = host.browsers.find((b) => b.channel === 'chrome');
    if (chrome?.installed === true) {
      out.status(
        'ok',
        'Google Chrome',
        `already installed${chrome.version === null ? '' : ` ${chrome.version}`}`,
      );
    } else if (!(await installChrome(context))) {
      return false;
    } else {
      host = await detectHostBrowsers(context);
    }
  }

  let chosen: Channel | null = options.channel;
  const canAsk = interactive(context, host);
  if (chosen === null && canAsk) {
    const entries = menuEntries(host, current, deps.host);
    out.line();
    out.lines(renderMenu(entries));
    const fallback = entries.findIndex((e) => e.kind === 'channel' && e.channel === current) + 1;
    for (let attempt = 0; attempt < 3 && chosen === null; attempt += 1) {
      const answer = await ask(context, `Choice [${fallback}]: `);
      // Enter keeps the current choice: nothing changes, nothing is written.
      if (answer === '') break;
      const index = Number.parseInt(answer, 10);
      const entry = Number.isInteger(index) ? entries[index - 1] : undefined;
      if (entry === undefined) {
        out.line(`  Type a number from 1 to ${entries.length}, or press Enter to keep ${current}.`);
        continue;
      }
      if (entry.kind === 'install-chrome') {
        if (!(await installChrome(context))) return false;
        host = await detectHostBrowsers(context);
      }
      chosen = entry.channel;
    }
  }

  if (chosen === null || chosen === current) {
    out.status('ok', 'default browser', `${current}${chosen === null ? '' : ' (unchanged)'}`);
    return true;
  }
  const picked = host.browsers.find((b) => b.channel === chosen);
  if (picked === undefined || !picked.installed) {
    out.status(
      'fail',
      'default browser',
      `${picked?.label ?? chosen} is not installed${chosen === 'chrome' ? '; add --installChrome' : ''}. Nothing was changed.`,
    );
    return false;
  }
  const referenced = fileReference(options.resolved);
  if (referenced !== undefined) {
    // Rewriting the key would silently drop the operator's reference (spec 08 §7.1).
    out.status(
      'fail',
      'default browser',
      `defaultChannel in ${options.resolved.configFilePath ?? 'the config file'} is read from $${referenced}; set ${referenced}=${chosen} instead. Nothing was changed.`,
    );
    return false;
  }
  const target = configTarget(options.resolved);
  let confirmed = options.yes;
  if (!confirmed && canAsk) {
    const answer = await ask(context, `Save defaultChannel=${chosen} to ${target.path}? [Y/n] `);
    confirmed = answer === '' || /^y(es)?$/i.test(answer);
    if (!confirmed) {
      out.status('ok', 'default browser', `${current} (not saved)`);
      return true;
    }
  }
  if (!confirmed) {
    out.status(
      'fail',
      'default browser',
      `not saved: add --yes to write defaultChannel=${chosen} to ${target.path} without a prompt`,
    );
    return false;
  }
  const failure = await saveDefaultChannel(context, target, chosen);
  if (failure !== null) {
    out.status('fail', 'default browser', failure);
    return false;
  }
  out.status(
    'ok',
    'saved',
    `defaultChannel=${chosen} in ${target.path}. Override any time with --defaultChannel or BROWSERHIVE_DEFAULT_CHANNEL.`,
  );
  const shadow = overriddenBy(options.resolved);
  if (shadow !== null) {
    out.status('warn', 'default browser', `${shadow} is set and still overrides the config file`);
  }
  return true;
}
