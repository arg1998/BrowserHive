/** @module cli/commands/config — `config show` (provenance table / `--json` view), `config schema` (JSON Schema of the config file), `config validate` (spec 08 §7.1) */
import { configFileJsonSchema } from '@browserhive/contracts/config';
import {
  configShowRows,
  configSourceSummary,
  configView,
  type ResolvedConfigBundle,
} from '@browserhive/core/config';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode } from '../invocation.ts';

/**
 * Prints the shadow lines and resolver warnings (stderr; they are diagnostics).
 */
export function printDiagnostics(context: CommandContext, resolved: ResolvedConfigBundle): void {
  for (const warning of resolved.diagnostics.warnings) {
    context.out.diagnostic(`browserhive: warning: ${warning}`);
  }
  for (const line of resolved.diagnostics.shadowLines) context.out.diagnostic(line.text);
}

/**
 * Runs `config show`.
 *
 * @returns Exit code 0.
 */
export function runConfigShow(
  context: CommandContext,
  resolved: ResolvedConfigBundle,
  json: boolean,
): ExitCode {
  const { out } = context;
  if (json) {
    // Unset optional keys print `"value": null` so every key has the same shape.
    const view = configView(resolved.config, resolved.provenance);
    out.json(
      Object.fromEntries(
        Object.entries(view).map(([key, entry]) => [key, { ...entry, value: entry.value ?? null }]),
      ),
    );
    return EXIT.ok;
  }
  const rows = configShowRows(resolved.provenance).map((row) => [
    out.style.bold(row.key),
    row.value,
    row.source === 'default' ? out.style.dim(row.source) : out.style.cyan(row.source),
    row.shadowed.join(', '),
  ]);
  out.table(
    [{ header: 'KEY' }, { header: 'VALUE' }, { header: 'SOURCE' }, { header: 'SHADOWED' }],
    rows,
  );
  out.line();
  out.line(
    `Config file: ${resolved.configFilePath ?? 'none'}  ·  sources: ${configSourceSummary(
      resolved.provenance,
      resolved.configFilePath,
    )}`,
  );
  return EXIT.ok;
}

/**
 * Runs `config schema`: the JSON Schema of `browserhive.config.json`.
 *
 * @returns Exit code 0.
 */
export function runConfigSchema(context: CommandContext): ExitCode {
  context.out.json(configFileJsonSchema());
  return EXIT.ok;
}

/**
 * Runs `config validate` for a configuration the planner already resolved (failures exit 64/3
 * at planning time with exactly the text `serve` prints).
 *
 * @returns Exit code 0.
 */
export function runConfigValidate(
  context: CommandContext,
  resolved: ResolvedConfigBundle,
): ExitCode {
  printDiagnostics(context, resolved);
  const file = resolved.configFilePath === undefined ? 'no config file' : resolved.configFilePath;
  context.out.status('ok', 'configuration is valid', file);
  return EXIT.ok;
}
