/** @module cli/commands/sitepacks-verify — `browserhive sitepacks verify <path>`: checks a site pack file offline (size, JSON, known strategies, the `SitePackV1` schema and the refinements of spec 13 §9.10) and prints its issues and warnings; exit 0 when valid, 1 otherwise (spec 13 §11.5). The binary's `min_client` range is not checked: a pack may target another release. */
import { basename } from 'node:path';
import { SITE_PACK_MAX_BYTES } from '@browserhive/contracts/site-packs';
import { loadPackBytes } from '@browserhive/core/server';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation } from '../invocation.ts';
import { printable } from '../output/printable.ts';

type VerifyInvocation = Extract<Invocation, { readonly command: 'sitepacks-verify' }>;

/** `sitepacks verify --json`. */
export interface VerifyReport {
  readonly path: string;
  readonly ok: boolean;
  readonly pack_id: string | null;
  readonly version: number | null;
  readonly sha256: string | null;
  readonly size: number | null;
  /** Why the file was refused (`invalid`, `too_large`, `unknown_strategy`, `id_mismatch`, `unreadable`). */
  readonly reason: string | null;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
  readonly warnings: readonly string[];
}

/** The pack id the file name promises (`linkedin.com.json` → `linkedin.com`). */
function expectedIdOf(path: string): string | null {
  const name = basename(path);
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : null;
}

/**
 * Checks one file.
 *
 * @returns The report.
 */
export async function verifyPackFile(context: CommandContext, path: string): Promise<VerifyReport> {
  const refused = (reason: string, message: string): VerifyReport => ({
    path,
    ok: false,
    pack_id: null,
    version: null,
    sha256: null,
    size: null,
    reason,
    issues: [{ path: '', message }],
    warnings: [],
  });
  const stat = await context.deps.fs.stat(path).catch(() => null);
  if (stat === null || !stat.isFile) return refused('unreadable', `cannot read ${path}`);
  if (stat.sizeBytes > SITE_PACK_MAX_BYTES) {
    return refused(
      'too_large',
      `${stat.sizeBytes} bytes; a pack is at most ${SITE_PACK_MAX_BYTES}`,
    );
  }
  let text: string;
  try {
    text = await context.deps.fs.readFile(path);
  } catch {
    return refused('unreadable', `cannot read ${path}`);
  }
  const bytes = new TextEncoder().encode(text);
  const loaded = loadPackBytes(bytes, {
    origin: path,
    binaryVersion: null,
    expectedId: expectedIdOf(path),
  });
  if (!loaded.ok) {
    return {
      path,
      ok: false,
      pack_id: loaded.error.packId === path ? null : loaded.error.packId,
      version: loaded.error.version,
      sha256: null,
      size: bytes.byteLength,
      reason: loaded.error.reason,
      issues: loaded.error.issues.map((i) => ({ path: i.path, message: i.message })),
      warnings: [],
    };
  }
  const { pack, sha256, size, warnings } = loaded.value;
  return {
    path,
    ok: true,
    pack_id: pack.id,
    version: pack.version,
    sha256,
    size,
    reason: null,
    issues: [],
    warnings: [...warnings],
  };
}

/**
 * Runs `sitepacks verify`.
 *
 * @returns 0 when the pack is valid, 1 otherwise.
 */
export async function runSitepacksVerify(
  context: CommandContext,
  invocation: VerifyInvocation,
): Promise<ExitCode> {
  // Everything in the report can come from the (possibly hostile) file: make it printable first
  // (verify #83 N2), JSON included.
  const report = printableReport(await verifyPackFile(context, invocation.path));
  const { out } = context;
  if (invocation.json) {
    out.json(report);
  } else if (report.ok) {
    out.status(
      'ok',
      `${report.pack_id ?? ''} v${report.version ?? 0}`,
      `valid (${report.size ?? 0} bytes, sha256 ${report.sha256 ?? ''})`,
    );
    for (const warning of report.warnings) out.line(`  warning: ${warning}`);
  } else {
    out.status(
      'fail',
      printable(invocation.path),
      `not a valid site pack (${report.reason ?? 'invalid'})`,
    );
    for (const issue of report.issues) {
      out.line(`  ${issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`}`);
    }
  }
  return report.ok ? EXIT.ok : EXIT.fatal;
}

/** The report with every string made printable (paths, ids, issue texts, warnings). */
function printableReport(report: VerifyReport): VerifyReport {
  return {
    ...report,
    path: printable(report.path),
    pack_id: report.pack_id === null ? null : printable(report.pack_id),
    sha256: report.sha256 === null ? null : printable(report.sha256),
    reason: report.reason === null ? null : printable(report.reason),
    issues: report.issues.map((i) => ({ path: printable(i.path), message: printable(i.message) })),
    warnings: report.warnings.map(printable),
  };
}
