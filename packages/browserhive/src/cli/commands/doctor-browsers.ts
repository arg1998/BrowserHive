/** @module cli/commands/doctor-browsers — the `doctor` checks for browser choice and the sandbox: installed Chrome/Edge, the configured channel, version drift, managed policies, the sandbox per channel and root/container (plan §3.3) */
import type { Channel } from '@browserhive/contracts/enums';
import type {
  DetectedBrowser,
  GuidanceAlternative,
  SandboxEnvironment,
  SandboxGuidanceInput,
  SandboxProbeResult,
} from '@browserhive/core/server';
import type { CliDeps } from '../deps.ts';
import type { CheckResult, CheckStatus } from './doctor-checks.ts';

/** The `sandbox` setting as doctor judges it. */
export type SandboxMode = 'auto' | 'on' | 'off';

/** The `sandbox` setting of a resolved config (`off` before the key existed). */
export function sandboxModeOf(config: Readonly<Record<string, unknown>> | null): SandboxMode {
  const value = config?.['sandbox'];
  return value === 'auto' || value === 'on' || value === 'off' ? value : 'off';
}

/** What the browser checks found, for the rows and the guidance block. */
export interface BrowserFindings {
  readonly browsers: readonly DetectedBrowser[];
  readonly environment: SandboxEnvironment;
  /** Probe verdict per installed channel (absent: not installed, or skipped as root). */
  readonly sandbox: ReadonlyMap<Channel, SandboxProbeResult>;
  /** Guidance input for the configured channel when it cannot sandbox, else null. */
  readonly guidance: SandboxGuidanceInput | null;
}

function row(check: string, status: CheckStatus, detail: string): CheckResult {
  return { check, status, detail };
}

function major(version: string | null): number | null {
  const head = version?.split('.')[0];
  return head === undefined ? null : Number.parseInt(head, 10);
}

function product(browser: DetectedBrowser): string {
  const version = browser.version === null ? '' : ` ${browser.version}`;
  return browser.source === 'bundled'
    ? `bundled ${browser.label}${version}`
    : `${browser.label}${version}`;
}

/** Install hint for a branded browser that is missing. */
function installHint(channel: Channel): string {
  return channel === 'chrome'
    ? "'browserhive init --installChrome'"
    : 'install Microsoft Edge from microsoft.com/edge';
}

/** How the sandbox setting reads to an operator (`sandbox=on`). */
function modeText(mode: SandboxMode): string {
  return `sandbox=${mode}`;
}

/**
 * Probes and detects everything the browser checks need. Probing launches each installed browser
 * once or twice (about a second each), skipped entirely as root, where Chrome refuses the sandbox.
 *
 * @returns The findings.
 */
export async function collectBrowserFindings(
  deps: CliDeps,
  defaultChannel: Channel,
  setting: string,
): Promise<BrowserFindings> {
  const [browsers, environment] = await Promise.all([
    deps.probes.browsers(),
    deps.probes.sandboxEnvironment(),
  ]);
  const sandbox = new Map<Channel, SandboxProbeResult>();
  if (!environment.root) {
    for (const browser of browsers) {
      if (browser.installed)
        sandbox.set(browser.channel, await deps.probes.sandbox(browser.channel));
    }
  }
  const target = browsers.find((b) => b.channel === defaultChannel);
  const verdict = sandbox.get(defaultChannel);
  let guidance: SandboxGuidanceInput | null = null;
  const reason =
    verdict?.state === 'unavailable'
      ? verdict.reason
      : environment.root && target?.installed === true
        ? 'Running as root without --no-sandbox is not supported.'
        : null;
  if (target !== undefined && reason !== null) {
    const alternatives: GuidanceAlternative[] = browsers
      .filter((b) => b.channel !== defaultChannel)
      .map((b) => {
        const probed = sandbox.get(b.channel);
        return {
          channel: b.channel,
          label: b.label,
          state: !b.installed ? 'not-installed' : (probed?.state ?? 'unknown'),
        };
      });
    guidance = {
      target: {
        channel: target.channel,
        label: target.label,
        source: target.source,
        version: target.version,
        executablePath: target.executablePath,
      },
      reason,
      env: environment,
      apparmorCovered:
        target.executablePath === null
          ? null
          : await deps.probes.apparmorCovers(target.executablePath),
      alternatives,
      requiredBy: { kind: 'config', setting },
    };
  }
  return { browsers, environment, sandbox, guidance };
}

/**
 * The browser and sandbox rows.
 *
 * @returns Rows in display order.
 */
export function browserRows(
  findings: BrowserFindings,
  config: {
    readonly defaultChannel: Channel;
    readonly sandbox: SandboxMode;
    readonly pinnedChromium: string | null;
  },
): CheckResult[] {
  const rows: CheckResult[] = [];
  const { browsers, environment, sandbox } = findings;

  for (const browser of browsers) {
    if (browser.source === 'bundled') continue;
    rows.push(
      browser.installed
        ? row(
            browser.channel,
            'ok',
            `${product(browser)} · ${browser.executablePath ?? 'installed'}`,
          )
        : row(browser.channel, 'ok', `not installed (optional; ${installHint(browser.channel)})`),
    );
  }

  const configured = browsers.find((b) => b.channel === config.defaultChannel);
  if (configured === undefined || !configured.installed) {
    const fix =
      config.defaultChannel === 'chromium'
        ? "run 'browserhive init'"
        : `${installHint(config.defaultChannel)}, or set defaultChannel=chromium`;
    rows.push(
      row(
        'default channel',
        'fail',
        `defaultChannel=${config.defaultChannel} but ${configured?.label ?? config.defaultChannel} is not installed; ${fix}`,
      ),
    );
  } else {
    rows.push(row('default channel', 'ok', `${config.defaultChannel} · ${product(configured)}`));
  }

  const pinnedMajor = major(config.pinnedChromium);
  const branded = browsers.filter((b) => b.source === 'installed' && b.installed);
  if (branded.length > 0 && pinnedMajor !== null) {
    const ahead = branded.filter((b) => {
      const m = major(b.version);
      return m !== null && m - pinnedMajor > 1;
    });
    const inUse = ahead.filter((b) => b.channel === config.defaultChannel);
    if (ahead.length === 0) {
      rows.push(
        row(
          'version drift',
          'ok',
          `${branded.map((b) => `${b.label} ${major(b.version) ?? '?'}`).join(', ')}: within one major version of the tested Chromium ${pinnedMajor}`,
        ),
      );
    } else {
      const text = ahead
        .map(
          (b) =>
            `${b.label} ${major(b.version) ?? '?'}${b.channel === config.defaultChannel ? '' : ' (not in use)'}`,
        )
        .join(', ');
      rows.push(
        row(
          'version drift',
          inUse.length > 0 ? 'warn' : 'ok',
          `${text} is more than one major version ahead of the Chromium ${pinnedMajor} this BrowserHive was tested with; update BrowserHive, or use the bundled Chromium`,
        ),
      );
    }
  }

  const withPolicies = branded.filter((b) => b.policies.location !== null);
  if (withPolicies.length === 0) {
    rows.push(row('managed policies', 'ok', 'none'));
  } else {
    const blocking = withPolicies.filter((b) => b.policies.blocking.length > 0);
    const blocksDefault = blocking.some((b) => b.channel === config.defaultChannel);
    const status: CheckStatus = blocksDefault ? 'fail' : blocking.length > 0 ? 'warn' : 'ok';
    const detail = withPolicies
      .map((b) =>
        b.policies.blocking.length > 0
          ? `${b.label}: ${b.policies.blocking.join(', ')} blocks automation (${b.policies.location ?? ''})`
          : `${b.label}: ${b.policies.names.length} managed ${b.policies.names.length === 1 ? 'policy' : 'policies'}, none block automation`,
      )
      .join('; ');
    rows.push(row('managed policies', status, detail));
  }

  if (environment.root) {
    const status: CheckStatus =
      config.sandbox === 'on' ? 'fail' : config.sandbox === 'auto' ? 'warn' : 'ok';
    rows.push(
      row(
        'sandbox',
        status,
        `${modeText(config.sandbox)}; running as root: Chrome refuses the sandbox as root, so sessions run without it`,
      ),
    );
  } else {
    for (const browser of browsers) {
      const verdict = sandbox.get(browser.channel);
      if (!browser.installed || verdict === undefined) continue;
      rows.push(sandboxRow(browser.channel, verdict, config));
    }
  }

  rows.push(
    environment.root || environment.container
      ? row(
          'user',
          config.sandbox === 'off' ? 'ok' : 'warn',
          `${environment.root ? 'running as root' : 'normal user'}${environment.container ? ' in a container' : ''}: Chromium's sandbox needs a normal user${environment.container ? " and Playwright's seccomp profile" : ''}`,
        )
      : row('user', 'ok', 'normal user, not in a container'),
  );
  return rows;
}

function sandboxRow(
  channel: Channel,
  verdict: SandboxProbeResult,
  config: { readonly defaultChannel: Channel; readonly sandbox: SandboxMode },
): CheckResult {
  const name = `sandbox (${channel})`;
  const isDefault = channel === config.defaultChannel;
  switch (verdict.state) {
    case 'works':
      return row(
        name,
        'ok',
        config.sandbox === 'off'
          ? `can run sandboxed here, but ${modeText(config.sandbox)}; set sandbox=auto to use it`
          : `runs sandboxed (${modeText(config.sandbox)})`,
      );
    case 'unavailable': {
      if (config.sandbox === 'off') {
        return row(
          name,
          'ok',
          `${modeText(config.sandbox)}; cannot run sandboxed here: ${verdict.reason}`,
        );
      }
      if (config.sandbox === 'on') {
        return row(
          name,
          isDefault ? 'fail' : 'warn',
          isDefault
            ? `cannot run sandboxed here, and ${modeText(config.sandbox)} refuses to start: ${verdict.reason}`
            : `cannot run sandboxed here; launch_session for it gets SANDBOX_UNAVAILABLE: ${verdict.reason}`,
        );
      }
      return row(
        name,
        'warn',
        `cannot run sandboxed here, falls back to no sandbox (${modeText(config.sandbox)}): ${verdict.reason}`,
      );
    }
    case 'broken':
      return row(
        name,
        'warn',
        `the browser did not start, even without the sandbox: ${verdict.reason}`,
      );
    case 'not-installed':
      return row(name, 'ok', 'not installed');
  }
}
