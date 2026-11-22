/** @module cli/commands/sitepacks-verify-layout — `browserhive sitepacks verify <dir>` for a signed registry layout (spec 13 §10.1, §11.5, T4a): `keys.json` against the root keys pinned in this binary, `index.json` against its online keys, every listed pack file against the index, with the same verifier a fetch uses (`verifySignedLayout`). Offline; no stored floors (the server keeps those). A layout signed by any other root (a pull-request preview's test key) is refused. */
import { join } from 'node:path';
import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import { PINNED_TRUST_ROOT, verifySignedLayout } from '@browserhive/core/server';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode } from '../invocation.ts';
import { printable } from '../output/printable.ts';

/** `sitepacks verify <dir> --json`. */
export interface LayoutReport {
  readonly path: string;
  readonly kind: 'layout';
  readonly ok: boolean;
  readonly keys: {
    readonly version: number;
    readonly expires: string;
    readonly signed_by: string;
    readonly online: readonly { readonly key_id: string; readonly not_after: string }[];
  } | null;
  readonly index: {
    readonly version: number;
    readonly issued_at: string;
    readonly expires: string;
    readonly signed_by: string;
  } | null;
  /** Why the chain was refused (`file`, `reason`, `detail`); `null` when it verified. */
  readonly refusal: {
    readonly file: string;
    readonly reason: string;
    readonly detail: string;
  } | null;
  readonly packs: readonly {
    readonly id: string;
    readonly version: number;
    readonly sha256: string;
    /** `ok`, `absent`, `refused`, or `other_client` (valid, for another BrowserHive). */
    readonly status: string;
    readonly detail: string | null;
    readonly revoked: boolean;
  }[];
}

/** Whether `path` is a folder (a layout) rather than a pack file. */
export async function isLayoutDir(context: CommandContext, path: string): Promise<boolean> {
  const stat = await context.deps.fs.stat(path).catch(() => null);
  return stat?.isDirectory === true;
}

/**
 * Verifies the layout in `dir`.
 *
 * @returns The report, every string made printable (the files may be hostile).
 */
export async function verifyLayoutDir(context: CommandContext, dir: string): Promise<LayoutReport> {
  const { fs } = context.deps;
  const root: SitePacksTrustRoot = context.deps.sitePacksTrustRoot ?? PINNED_TRUST_ROOT;
  const read = async (rel: string, maxBytes: number) => {
    const file = join(dir, ...rel.split('/'));
    const stat = await fs.stat(file).catch(() => null);
    if (stat === null || !stat.isFile) return null;
    if (stat.sizeBytes > maxBytes) return 'too_large' as const;
    return new TextEncoder().encode(await fs.readFile(file));
  };
  const report = await verifySignedLayout({
    read,
    root,
    now: context.deps.clock.now(),
    binaryVersion: context.deps.appVersion,
  });
  const keys = report.keys;
  const index = report.index;
  return {
    path: printable(dir),
    kind: 'layout',
    ok: report.ok,
    keys:
      keys === null
        ? null
        : {
            version: keys.value.version,
            expires: keys.value.expires,
            signed_by: keys.signedBy,
            online: keys.value.online.map((k) => ({ key_id: k.key_id, not_after: k.not_after })),
          },
    index:
      index === null
        ? null
        : {
            version: index.value.version,
            issued_at: index.value.issued_at,
            expires: index.value.expires,
            signed_by: index.signedBy,
          },
    refusal:
      report.refusal === null
        ? null
        : {
            file: printable(report.refusal.file),
            reason: report.refusal.reason,
            detail: printable(report.refusal.detail),
          },
    packs: report.packs.map((p) => ({
      id: printable(p.id),
      version: p.version,
      sha256: p.sha256,
      status: p.status,
      detail: p.detail === null ? null : printable(p.detail),
      revoked: p.revoked,
    })),
  };
}

/**
 * Prints a layout report.
 *
 * @returns 0 when the layout verified, 1 otherwise.
 */
export function printLayoutReport(
  context: CommandContext,
  report: LayoutReport,
  json: boolean,
): ExitCode {
  const { out } = context;
  if (json) {
    out.json(report);
    return report.ok ? EXIT.ok : EXIT.fatal;
  }
  if (report.refusal !== null) {
    out.status('fail', report.path, 'not a valid signed registry layout');
    out.line(`  ${report.refusal.file}: ${report.refusal.reason} (${report.refusal.detail})`);
    return EXIT.fatal;
  }
  const verified = report.packs.filter((p) => p.status === 'ok' || p.status === 'other_client');
  out.status(
    report.ok ? 'ok' : 'fail',
    report.path,
    `${report.ok ? 'valid' : 'not valid'}: keys.json v${report.keys?.version ?? 0} (root ${report.keys?.signed_by ?? ''}), index.json v${report.index?.version ?? 0} (online key ${report.index?.signed_by ?? ''}, expires ${report.index?.expires ?? ''}), ${verified.length} of ${report.packs.length} pack files verified`,
  );
  for (const p of report.packs) {
    if (p.status === 'ok' && !p.revoked) continue;
    const what = p.status === 'other_client' ? p.detail : p.status === 'ok' ? 'revoked' : p.status;
    out.line(
      `  ${p.id} v${p.version}: ${what}${p.status === 'refused' ? ` (${p.detail ?? ''})` : ''}`,
    );
  }
  return report.ok ? EXIT.ok : EXIT.fatal;
}
