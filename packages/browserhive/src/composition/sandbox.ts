/** @module composition/sandbox — the `sandbox` setting at boot: the process's `SandboxPolicy`, the `sandbox=on` preflight that refuses to start (exit code 3) with guidance computed for this host, and the browser/sandbox facts `/system` reports (plan §3.4, §3.5). */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Provenance, ServerConfig } from '@browserhive/contracts/config';
import type { Channel } from '@browserhive/contracts/enums';
import type { SystemBrowser } from '@browserhive/contracts/http';
import type { AppError, Clock, Logger } from '@browserhive/core/runtime';
import type {
  DetectedBrowser,
  DriverResolver,
  GuidanceAlternative,
  GuidanceTarget,
  SandboxEnvironment,
  SandboxGuidanceInput,
  SandboxProbeResult,
  SandboxTarget,
} from '@browserhive/core/server';
import {
  apparmorProfileCovers,
  bundledChromiumVersion,
  CHANNEL_LABEL,
  channelExecutable,
  detectBrowsers,
  inspectSandboxEnvironment,
  playwrightChannelExecutable,
  probeSandbox,
  renderSandboxGuidance,
  SandboxPolicy,
  sandboxGuidance,
  sandboxUnavailable,
  shortSandboxGuidance,
} from '@browserhive/core/server';

/** Host access; tests replace the probes (no real browser launches). */
export interface SandboxHost {
  readonly environment: () => SandboxEnvironment;
  readonly probe: (channel: Channel) => Promise<SandboxProbeResult>;
  readonly detect: () => Promise<readonly DetectedBrowser[]>;
  readonly executable: (channel: Channel) => string | null;
  readonly apparmorCovers: (path: string) => boolean | null;
}

/** Inputs of {@link buildSandbox}. */
export interface SandboxInput {
  readonly config: Readonly<ServerConfig>;
  readonly provenance: Provenance;
  readonly configFilePath: string | undefined;
  readonly resolver: DriverResolver;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Test seam; defaults to {@link realSandboxHost}. */
  readonly host?: SandboxHost;
}

/** What the rest of the composition uses. */
export interface SandboxWiring {
  readonly policy: SandboxPolicy;
  /** `/system`'s browser block: detection runs once (lazily), verdicts are read live. */
  describe(): Promise<SystemBrowser>;
}

const PLAYWRIGHT_CHANNEL: Readonly<Record<Channel, string>> = {
  chromium: 'chromium',
  chrome: 'chrome',
  edge: 'msedge',
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function listDir(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

async function runHelper(
  command: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string }> {
  try {
    const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => child.kill(), 10_000);
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    clearTimeout(timer);
    return { code, stdout };
  } catch {
    return { code: null, stdout: '' };
  }
}

/** The BrowserType the configured sessions launch `chromium` through (Patchright's when stealth uses it). */
function sessionBrowserType(
  resolver: DriverResolver,
  config: Pick<ServerConfig, 'stealth' | 'stealthDriver'>,
): ReturnType<DriverResolver['stock']> {
  if (config.stealth === 'off') return resolver.stock();
  try {
    return resolver.resolveStealth(config.stealthDriver).browserType;
  } catch {
    return resolver.stock();
  }
}

function bundledPath(
  resolver: DriverResolver,
  config: Pick<ServerConfig, 'stealth' | 'stealthDriver'>,
): string | null {
  try {
    const path = sessionBrowserType(resolver, config).executablePath();
    return path !== '' && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * The real host: files, `--version`, and headless probe launches through the driver sessions use,
 * so the verdict is recorded for the same executable sessions launch.
 */
export function realSandboxHost(
  resolver: DriverResolver,
  config: Pick<ServerConfig, 'stealth' | 'stealthDriver'>,
): SandboxHost {
  return {
    environment: () =>
      inspectSandboxEnvironment({
        platform: process.platform,
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
        exists: existsSync,
        readFile: readText,
      }),
    probe: (channel) =>
      probeSandbox(sessionBrowserType(resolver, config), {
        playwrightChannel: PLAYWRIGHT_CHANNEL[channel],
      }),
    detect: () =>
      detectBrowsers({
        platform: process.platform,
        env: process.env,
        exists: existsSync,
        readFile: readText,
        listDir,
        run: runHelper,
        bundled: {
          executablePath: bundledPath(resolver, config),
          version: bundledChromiumVersion('playwright'),
        },
      }),
    executable: (channel) =>
      channelExecutable(channel, () => bundledPath(resolver, config), playwrightChannelExecutable),
    apparmorCovers: (path) =>
      apparmorProfileCovers(path, { platform: process.platform, listDir, readFile: readText }),
  };
}

/** How `sandbox=on` was set, as the operator would type it again (`--sandbox on`). */
export function sandboxSetting(
  provenance: Provenance,
  configFilePath: string | undefined,
  mode: string,
): string {
  switch (provenance.sandbox.source) {
    case 'cli':
      return `--sandbox ${mode}`;
    case 'env':
      return `BROWSERHIVE_SANDBOX=${mode}`;
    case 'file': {
      const file = configFilePath ?? 'the config file';
      // A reference (spec 08 §3.1): quote what the file says, then what it resolved to.
      const template = provenance.sandbox.template;
      return template === undefined
        ? `"sandbox": "${mode}" in ${file}`
        : `"sandbox": "${template}" in ${file}, resolved to ${mode}`;
    }
    default:
      return `sandbox=${mode}`;
  }
}

function targetOf(
  channel: Channel,
  executablePath: string | null,
  found: DetectedBrowser | undefined,
): GuidanceTarget {
  return {
    channel,
    label: found?.label ?? CHANNEL_LABEL[channel],
    source: channel === 'chromium' ? 'bundled' : 'installed',
    version: found?.version ?? null,
    executablePath: found?.executablePath ?? executablePath,
  };
}

/**
 * Builds the policy and, under `sandbox=on`, runs the boot preflight: one headless launch of the
 * configured browser with the sandbox forced on (about 0.3 s when it fails). On failure every other
 * installed browser is probed so the refusal can say what works on this host.
 *
 * @throws `SANDBOX_UNAVAILABLE` (exit code 3) when `sandbox=on` cannot be honoured; nothing has started.
 */
export async function buildSandbox(input: SandboxInput): Promise<SandboxWiring> {
  const { config, logger } = input;
  const host = input.host ?? realSandboxHost(input.resolver, config);
  const environment = host.environment();
  const log = logger.child({ module: 'browsers.sandbox' });
  const setting = sandboxSetting(input.provenance, input.configFilePath, config.sandbox);

  const toolError = (args: {
    readonly target: SandboxTarget;
    readonly reason: string;
    readonly requiredBy: 'config' | 'launch_options';
    readonly workingChannels: readonly Channel[];
    readonly err?: unknown;
  }): AppError => {
    const guidanceInput: SandboxGuidanceInput = {
      target: targetOf(args.target.channel, args.target.executablePath, undefined),
      reason: args.reason,
      env: environment,
      apparmorCovered: null,
      alternatives: args.workingChannels.map((channel) => ({
        channel,
        label: CHANNEL_LABEL[channel],
        state: 'works',
      })),
      requiredBy:
        args.requiredBy === 'config' ? { kind: 'config', setting } : { kind: 'launch_options' },
    };
    const guidance = sandboxGuidance(guidanceInput);
    return sandboxUnavailable({
      channel: args.target.channel,
      reason: args.reason,
      requiredBy: args.requiredBy,
      alternatives: guidance.workingChannels,
      guidance: shortSandboxGuidance(guidanceInput, guidance),
      ...(guidance.cause !== null && { cause: guidance.cause }),
      ...(args.err !== undefined && { err: args.err }),
    });
  };

  const policy = new SandboxPolicy({
    mode: config.sandbox,
    root: environment.root,
    logger,
    clock: input.clock,
    unavailable: toolError,
  });

  if (config.sandbox === 'on') {
    await preflight({ channel: config.defaultChannel, host, environment, policy, setting, log });
  } else if (config.sandbox === 'auto' && environment.root) {
    log.warn('sandbox skipped as root', { mode: config.sandbox });
  }

  let detected: Promise<readonly DetectedBrowser[]> | undefined;
  return {
    policy,
    async describe() {
      detected ??= host.detect().catch(() => []);
      const browsers = await detected;
      return {
        default_channel: config.defaultChannel,
        sandbox_mode: config.sandbox,
        running_as_root: environment.root,
        channels: browsers.map((b) => {
          const verdict = policy.verdict({ channel: b.channel, executablePath: b.executablePath });
          return {
            channel: b.channel,
            label: b.label,
            source: b.source,
            installed: b.installed,
            version: b.version,
            executable: b.executablePath,
            sandbox:
              verdict === undefined
                ? 'unknown'
                : verdict.state === 'works'
                  ? 'sandboxed'
                  : 'unavailable',
            sandbox_reason: verdict?.reason ?? null,
          };
        }),
      };
    },
  };
}

async function preflight(args: {
  readonly channel: Channel;
  readonly host: SandboxHost;
  readonly environment: SandboxEnvironment;
  readonly policy: SandboxPolicy;
  readonly setting: string;
  readonly log: Logger;
}): Promise<void> {
  const { channel, host, policy, setting, log } = args;
  const executablePath = host.executable(channel);
  const result: SandboxProbeResult =
    executablePath === null ? { state: 'not-installed' } : await host.probe(channel);
  if (result.state === 'works') {
    policy.record({ channel, executablePath }, { state: 'works' });
    log.info('sandbox verified', { channel, version: result.version });
    return;
  }
  if (result.state === 'unavailable') {
    policy.record({ channel, executablePath }, { state: 'unavailable', reason: result.reason });
  }

  // Only on failure: find the way out on this host (probe every other installed browser).
  const browsers = await host.detect();
  const alternatives: GuidanceAlternative[] = [];
  for (const browser of browsers) {
    if (browser.channel === channel) continue;
    if (!browser.installed) {
      alternatives.push({ channel: browser.channel, label: browser.label, state: 'not-installed' });
      continue;
    }
    const verdict = await host.probe(browser.channel);
    if (verdict.state === 'works' || verdict.state === 'unavailable') {
      policy.record(
        { channel: browser.channel, executablePath: browser.executablePath },
        verdict.state === 'works' ? { state: 'works' } : verdict,
      );
    }
    alternatives.push({ channel: browser.channel, label: browser.label, state: verdict.state });
  }
  const found = browsers.find((b) => b.channel === channel);
  const target = targetOf(channel, executablePath, found);
  const reason =
    result.state === 'unavailable'
      ? result.reason
      : result.state === 'broken'
        ? `the browser did not start at all: ${result.reason}`
        : `${target.label} is not installed`;
  const guidanceInput: SandboxGuidanceInput = {
    target,
    reason,
    env: args.environment,
    apparmorCovered:
      target.executablePath === null ? null : host.apparmorCovers(target.executablePath),
    alternatives,
    requiredBy: { kind: 'config', setting },
  };
  const guidance = sandboxGuidance(guidanceInput);
  const headline =
    result.state === 'not-installed'
      ? `The sandbox is required (${setting}) but the configured browser (${channel}) is not installed, so it cannot be checked.`
      : `The sandbox is required (${setting}) but the configured browser cannot run sandboxed.`;
  const lines =
    result.state === 'not-installed'
      ? [
          '',
          `  Install it first: ${channel === 'chromium' ? 'browserhive init' : channel === 'chrome' ? 'browserhive init --installChrome' : 'install Microsoft Edge from microsoft.com/edge'}`,
          '  or choose another browser with --defaultChannel.',
        ]
      : renderSandboxGuidance(guidanceInput, guidance);
  log.error('sandbox required', { channel, reason, working: guidance.workingChannels });
  throw sandboxUnavailable({
    channel,
    reason,
    requiredBy: 'config',
    alternatives: guidance.workingChannels,
    guidance: [...lines, '', "Exit code 3. 'browserhive doctor' shows this check at any time."],
    headline,
    ...(target.executablePath !== null && { executable: target.executablePath }),
    ...(guidance.cause !== null && { cause: guidance.cause }),
  });
}
