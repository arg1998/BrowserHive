/** @module cli/commands/doctor — `browserhive doctor [--json]`: runs every host check, prints a table, exits 0 (all ✓), 1 (any ✗) or 2 (warnings only) (spec 08 §7.1) */
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation } from '../invocation.ts';
import type { StatusKind } from '../output/output.ts';
import { STATUS_GLYPH } from '../output/output.ts';
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
  checkSecretsFile,
  checkUnrecognisedDataFiles,
  checkVault,
} from './doctor-checks.ts';

type DoctorInvocation = Extract<Invocation, { readonly command: 'doctor' }>;

/**
 * Runs every check in order.
 *
 * @returns The results.
 */
export async function runChecks(
  context: CommandContext,
  invocation: DoctorInvocation,
): Promise<readonly CheckResult[]> {
  const { deps } = context;
  const { resolution, dataDir } = invocation;
  const results: CheckResult[] = [checkBun(deps), checkConfig(resolution)];
  const config = resolution.ok ? resolution.value.config : null;
  results.push(...(await checkBrowsers(deps, config?.stealthDriver ?? 'auto')));
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
  return results;
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
  const results = await runChecks(context, invocation);
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
  const count = (status: CheckResult['status']): number =>
    results.filter((r) => r.status === status).length;
  out.line();
  out.line(`${count('ok')} passed, ${count('warn')} warnings, ${count('fail')} failed`);
  return code;
}
