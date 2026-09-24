/** @module cli/commands/doctor — `browserhive doctor [--json]`: runs every host check, prints a table, exits 0 (all ✓), 1 (any ✗) or 2 (warnings only) (spec 08 §7.1) */
import type { Channel } from '@browserhive/contracts/enums';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation } from '../invocation.ts';
import type { StatusKind } from '../output/output.ts';
import { STATUS_GLYPH } from '../output/output.ts';
import {
  type BrowserFindings,
  browserRows,
  collectBrowserFindings,
  type SandboxMode,
  sandboxModeOf,
} from './doctor-browsers.ts';
import {
  type CheckResult,
  checkBrowsers,
  checkBun,
  checkCapacity,
  checkConfig,
  checkDatabase,
  checkDataDir,
  checkOtel,
  checkPort,
  checkReferenceDefaults,
  checkSecretsFile,
  checkUnrecognisedDataFiles,
  checkVault,
} from './doctor-checks.ts';

type DoctorInvocation = Extract<Invocation, { readonly command: 'doctor' }>;

/** The rows plus what the browser checks found (for the guidance block in text mode). */
export interface DoctorReport {
  readonly results: readonly CheckResult[];
  readonly browsers: BrowserFindings;
}

/** How the `sandbox` setting was supplied, as the operator would type it again. */
function sandboxSetting(invocation: DoctorInvocation, mode: SandboxMode): string {
  if (!invocation.resolution.ok) return `sandbox=${mode}`;
  const provenance: Readonly<Record<string, { readonly source: string } | undefined>> =
    invocation.resolution.value.provenance;
  switch (provenance['sandbox']?.source) {
    case 'cli':
      return `--sandbox ${mode}`;
    case 'env':
      return `BROWSERHIVE_SANDBOX=${mode}`;
    case 'file':
      return `"sandbox": "${mode}" in the config file`;
    default:
      return `sandbox=${mode}`;
  }
}

/**
 * Runs every check in order.
 *
 * @returns The results and the browser findings.
 */
export async function runChecks(
  context: CommandContext,
  invocation: DoctorInvocation,
): Promise<DoctorReport> {
  const { deps } = context;
  const { resolution, dataDir } = invocation;
  const results: CheckResult[] = [
    checkBun(deps),
    checkConfig(resolution),
    ...checkReferenceDefaults(resolution),
  ];
  const config = resolution.ok ? resolution.value.config : null;
  results.push(...(await checkBrowsers(deps, config?.stealthDriver ?? 'auto')));
  const defaultChannel: Channel = config?.defaultChannel ?? 'chromium';
  const mode = sandboxModeOf(config);
  const browsers = await collectBrowserFindings(
    deps,
    defaultChannel,
    sandboxSetting(invocation, mode),
  );
  results.push(
    ...browserRows(browsers, {
      defaultChannel,
      sandbox: mode,
      pinnedChromium: browsers.browsers.find((b) => b.channel === 'chromium')?.version ?? null,
    }),
  );
  results.push(await checkDataDir(deps, dataDir));
  if (config !== null) {
    results.push(await checkPort(deps, config, dataDir));
    results.push(await checkVault(deps, config));
  }
  results.push(await checkUnrecognisedDataFiles(deps, dataDir));
  results.push(await checkDatabase(deps, dataDir));
  if (config !== null && resolution.ok) {
    results.push(await checkOtel(deps, config));
    results.push(checkCapacity(deps, config));
    results.push(checkSecretsFile(deps, resolution.value));
  }
  return { results, browsers };
}

/**
 * Exit code of a set of results.
 *
 * @returns 1 when any failed, 2 when only warnings, else 0.
 */
export function doctorExitCode(results: readonly CheckResult[]): ExitCode {
  if (results.some((r) => r.status === 'fail')) return EXIT.fatal;
  if (results.some((r) => r.status === 'warn')) return EXIT.warnings;
  return EXIT.ok;
}

const KIND: Readonly<Record<CheckResult['status'], StatusKind>> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
};

/**
 * Runs `doctor`.
 *
 * @returns 0, 1 or 2.
 */
export async function runDoctor(
  context: CommandContext,
  invocation: DoctorInvocation,
): Promise<ExitCode> {
  const { out } = context;
  if (invocation.printApparmorProfile) return printApparmorProfile(context, invocation);
  const { results, browsers } = await runChecks(context, invocation);
  const code = doctorExitCode(results);
  if (invocation.json) {
    out.json(results);
    return code;
  }
  const glyph = (status: CheckResult['status']): string => {
    const text = STATUS_GLYPH[KIND[status]];
    return status === 'ok'
      ? out.style.green(text)
      : status === 'warn'
        ? out.style.yellow(text)
        : out.style.red(text);
  };
  out.table(
    [{ header: ' ' }, { header: 'CHECK' }, { header: 'DETAIL' }],
    results.map((r) => [glyph(r.status), r.check, r.detail]),
  );
  if (invocation.resolution.ok) {
    const shadow = invocation.resolution.value.diagnostics.shadowLines;
    if (shadow.length > 0) {
      out.line();
      for (const line of shadow) out.line(out.style.dim(line.text));
    }
  }
  if (browsers.guidance !== null) {
    const server = await import('@browserhive/core/server');
    const guidance = server.sandboxGuidance(browsers.guidance);
    out.line();
    out.line(
      `The configured browser (${browsers.guidance.target.channel}) cannot run with Chromium's sandbox on this host.`,
    );
    for (const line of server.renderSandboxGuidance(browsers.guidance, guidance)) out.line(line);
  }
  const count = (status: CheckResult['status']): number =>
    results.filter((r) => r.status === status).length;
  out.line();
  out.line(`${count('ok')} passed, ${count('warn')} warnings, ${count('fail')} failed`);
  return code;
}

/**
 * `doctor --printApparmorProfile`: prints an AppArmor profile for the configured channel's browser
 * (the bundled Chromium by default), for `sudo tee /etc/apparmor.d/…`. Prints only; never installs.
 *
 * @returns 0, or 1 when that browser is not installed.
 */
async function printApparmorProfile(
  context: CommandContext,
  invocation: DoctorInvocation,
): Promise<ExitCode> {
  const { deps, out } = context;
  const channel: Channel = invocation.resolution.ok
    ? invocation.resolution.value.config.defaultChannel
    : 'chromium';
  const browser = (await deps.probes.browsers()).find((b) => b.channel === channel);
  const path = browser?.installed === true ? browser.executablePath : null;
  if (path === null) {
    out.diagnostic(
      `browserhive: no ${browser?.label ?? channel} is installed for channel '${channel}', so there is no path to write a profile for.`,
    );
    return EXIT.fatal;
  }
  const server = await import('@browserhive/core/server');
  const name = channel === 'chromium' ? server.APPARMOR_PROFILE_NAME : `browserhive-${channel}`;
  out.line(server.apparmorProfile(path, name).trimEnd());
  return EXIT.ok;
}
