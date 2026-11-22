/** @module scripts/registry-verify — verifies a signed registry layout with core's verifier (the one `browserhive sitepacks verify <dir>` and the T4b client use), for CI's pull-request preview (spec 13 §10.2, T4a acceptance): `--test-root <file>` must accept it (the preview's throwaway root from `registry-sign.mjs --test-keys`), and `--expect-pinned-refusal` requires that the root keys pinned in this build refuse it, so a preview's key can never pass for a release's.
 *
 *   bun scripts/registry-verify.ts <dir> [--test-root <root.pub>]… [--expect-pinned-refusal]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import {
  PINNED_TRUST_ROOT,
  parseTrustRoot,
  type SignedLayoutReport,
  verifySignedLayout,
} from '@browserhive/core/server';

const args = process.argv.slice(2);
const dir = args[0];
if (dir === undefined || dir.startsWith('--')) {
  console.error('usage: registry-verify.ts <dir> [--test-root <file>] [--expect-pinned-refusal]');
  process.exit(64);
}

async function verify(root: SitePacksTrustRoot): Promise<SignedLayoutReport> {
  return verifySignedLayout({
    read: async (path) => {
      try {
        return new Uint8Array(readFileSync(join(resolve(dir ?? '.'), path)));
      } catch {
        return null;
      }
    },
    root,
    now: Date.now(),
    binaryVersion: null,
  });
}

function describe(report: SignedLayoutReport): string {
  if (report.refusal !== null) {
    return `refused: ${report.refusal.file} ${report.refusal.reason} (${report.refusal.detail})`;
  }
  const bad = report.packs.filter((p) => p.status !== 'ok' && p.status !== 'other_client');
  return `${report.ok ? 'valid' : 'invalid'}: keys.json v${report.keys?.value.version}, index.json v${report.index?.value.version}, ${report.packs.length - bad.length} of ${report.packs.length} pack files verified${bad.map((p) => `; ${p.id} v${p.version} ${p.status} ${p.detail ?? ''}`).join('')}`;
}

let failed = false;
// Every `--test-root <file>` given (a preview has one; the dry run's two roots both count).
const testRoots = args.flatMap((a, i) =>
  a === '--test-root' && args[i + 1] !== undefined ? [args[i + 1] ?? ''] : [],
);
if (testRoots.length > 0) {
  const pubs = testRoots.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const parsed = parseTrustRoot({
    keys: pubs.map((pub) => ({ keyId: pub.key_id, publicKey: pub.public_key })),
  });
  if (!parsed.ok) throw new Error(`${testRoots.join(', ')}: ${parsed.error}`);
  const report = await verify(parsed.value);
  console.log(`with the test root ${pubs.map((p) => p.key_id).join(', ')}: ${describe(report)}`);
  failed ||= !report.ok;
}
if (args.includes('--expect-pinned-refusal')) {
  const report = await verify(PINNED_TRUST_ROOT);
  console.log(`with this build's pinned root keys: ${describe(report)}`);
  if (report.ok) {
    console.error('registry-verify: the pinned root keys accept a test-key layout');
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
