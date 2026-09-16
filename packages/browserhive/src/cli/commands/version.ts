/** @module cli/commands/version — `browserhive version` / `--version`: `browserhive 0.1.0 (bun 1.4.2, sqlite 3.53.2, playwright 1.63.0, patchright 1.63.0|not installed)` (spec 08 §7.1) */
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode } from '../invocation.ts';

/** Machine-readable version report (`version --json`). */
export interface VersionReport {
  readonly browserhive: string;
  readonly bun: string;
  readonly sqlite: string;
  readonly playwright: string | null;
  readonly patchright: string | null;
  readonly schema_version: number;
}

/**
 * Collects the versions.
 *
 * @returns The report.
 */
export async function versionReport(context: CommandContext): Promise<VersionReport> {
  const { deps } = context;
  const [playwright, patchright, sqlite] = await Promise.all([
    deps.probes.playwright(),
    deps.probes.patchright(),
    deps.probes.sqliteVersion(),
  ]);
  return {
    browserhive: deps.appVersion,
    bun: deps.probes.bunVersion(),
    sqlite,
    playwright: playwright.packageVersion,
    patchright: patchright.packageVersion,
    schema_version: deps.schemaVersion,
  };
}

/**
 * The one-line text form.
 *
 * @returns `browserhive X (bun …, sqlite …, playwright …, patchright …)`.
 */
export function versionLine(report: VersionReport): string {
  return `browserhive ${report.browserhive} (bun ${report.bun}, sqlite ${report.sqlite}, playwright ${
    report.playwright ?? 'not installed'
  }, patchright ${report.patchright ?? 'not installed'})`;
}

/**
 * Runs `version`.
 *
 * @returns Exit code 0.
 */
export async function runVersion(context: CommandContext, json: boolean): Promise<ExitCode> {
  const report = await versionReport(context);
  if (json) context.out.json(report);
  else context.out.line(versionLine(report));
  return EXIT.ok;
}
