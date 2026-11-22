/** @module scripts/registry/dry-run — `registry-keys.ts dry-run`: the whole key ceremony with throwaway keys in a scratch folder (spec 13 §10.2), so the owner can rehearse it: both roots, an online key, a re-sign by the other root, a rotation and a revocation, then `keys.json` (and, with `--layout`, a signed index over a real build) verified by core's verifier with the throwaway root and refused by this build's pinned root. Nothing in the repository changes. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import {
  PINNED_TRUST_ROOT,
  type SignedLayoutReport,
  verifyKeys,
  verifySignedLayout,
} from '@browserhive/core/server';
import {
  canonicalJson,
  INDEX_LIFETIME_MS,
  instant,
  privateKeyFromPkcs8,
  readRootKeys,
  signatureFile,
} from '../registry-common.mjs';
import { readRootKeyFile } from './keyfile.ts';
import { addOnlineKey, initRoots, type KeyPaths, resignKeys } from './keys-ops.ts';

/** Inputs of {@link dryRun}. */
export interface DryRunInput {
  /** An empty scratch folder outside git. */
  readonly dir: string;
  /** A copy of `trust-root.ts` inside `dir` (its pinned list is rewritten like the real one). */
  readonly trustRoot: string;
  readonly now: number;
  /** An unsigned build (`registry-build.ts --out`) to sign with the throwaway online key. */
  readonly layout: string | null;
}

/** What the dry run produced (for its test). */
export interface DryRunResult {
  readonly root: SitePacksTrustRoot;
  readonly keysAccepted: boolean;
  readonly pinnedRefusal: string | null;
  readonly layout: SignedLayoutReport | null;
  readonly pinnedLayout: SignedLayoutReport | null;
}

const PASSPHRASE = 'dry-run throwaway passphrase';

function step(n: number, text: string): void {
  console.log(`\nStep ${n}. ${text}`);
}

function secretKey(path: string): {
  privateKey: ReturnType<typeof privateKeyFromPkcs8>;
  keyId: string;
} {
  const [, keyId, b64] = readFileSync(path, 'utf8').trim().split('.');
  return { privateKey: privateKeyFromPkcs8(Buffer.from(b64 ?? '', 'base64')), keyId: keyId ?? '' };
}

/** Runs the rehearsal. */
export async function dryRun(input: DryRunInput): Promise<DryRunResult> {
  const pub = join(input.dir, 'registry-keys');
  const offline = join(input.dir, 'offline');
  mkdirSync(pub, { recursive: true });
  mkdirSync(offline, { recursive: true, mode: 0o700 });
  const paths: KeyPaths = { pubDir: pub, trustRoot: input.trustRoot, test: true };
  console.log(
    `Dry run in ${input.dir}: throwaway keys, passphrase "${PASSPHRASE}". Nothing in the repository changes.`,
  );

  step(
    1,
    'init-roots: two root keys, each encrypted under its passphrase; their public halves become root-1.pub, root-2.pub and the pinned list in trust-root.ts.',
  );
  const made = initRoots(paths, offline, [PASSPHRASE, PASSPHRASE], input.now, false);
  for (const k of made) console.log(`  root ${k.slot}: ${k.keyId} -> ${k.file}`);
  const root1 = readRootKeyFile(join(offline, 'root-1.key'), PASSPHRASE);
  const root2 = readRootKeyFile(join(offline, 'root-2.key'), PASSPHRASE);

  step(
    2,
    'online-key (root 1): a CI key valid 90 days; keys.json version 1, signed by root 1; the secret value written for the environment secret.',
  );
  const first = addOnlineKey(paths, root1, join(offline, 'online-1.secret'), 90, {
    now: input.now,
    keysDays: 120,
  });
  console.log(`  online key ${first.keyId} until ${first.notAfter}`);

  step(
    3,
    'sign-keys (root 2): either root can re-sign keys.json (threshold 1 of 2), e.g. to extend its expiry.',
  );
  console.log(
    `  keys.json version ${resignKeys(paths, root2, { now: input.now, keysDays: 120 }).version}`,
  );

  step(
    4,
    'Rotation, every 90 days at the latest: online-key adds the next key, then revoke drops the old one.',
  );
  const second = addOnlineKey(paths, root1, join(offline, 'online-2.secret'), 90, {
    now: input.now,
    keysDays: 120,
  });
  const revoked = resignKeys(paths, root2, { now: input.now, keysDays: 120, revoke: first.keyId });
  console.log(
    `  added ${second.keyId}, revoked ${first.keyId}; keys.json version ${revoked.version}`,
  );

  step(
    5,
    "Verification with core's verifier: the throwaway root accepts keys.json; this build's pinned root refuses it.",
  );
  const roots = readRootKeys(pub);
  const root: SitePacksTrustRoot = {
    keys: roots.keys.map((k) => ({ keyId: k.key_id, publicKey: k.public_key })),
  };
  const bytes = new Uint8Array(readFileSync(join(pub, 'keys.json')));
  const sig = new Uint8Array(readFileSync(join(pub, 'keys.json.sig')));
  const accepted = verifyKeys({ bytes, sig, root, now: input.now, floor: null });
  const pinned = verifyKeys({ bytes, sig, root: PINNED_TRUST_ROOT, now: input.now, floor: null });
  console.log(
    `  throwaway root: ${accepted.ok ? 'accepted' : `refused (${accepted.error.reason})`}`,
  );
  console.log(
    `  pinned root: ${pinned.ok ? 'ACCEPTED (unexpected)' : `refused (${pinned.error.reason})`}`,
  );

  let layout: SignedLayoutReport | null = null;
  let pinnedLayout: SignedLayoutReport | null = null;
  if (input.layout !== null) {
    step(
      6,
      'A signed index over the build in --layout, as the CI signing job writes it, verified like a client would.',
    );
    const signed = join(input.dir, 'layout');
    const unsigned = JSON.parse(readFileSync(join(input.layout, 'index.json'), 'utf8'));
    const index = Buffer.from(
      canonicalJson({
        schema: 1,
        version: 1,
        issued_at: instant(input.now),
        expires: instant(input.now + INDEX_LIFETIME_MS),
        packs: unsigned.packs,
      }),
    );
    mkdirSync(signed, { recursive: true });
    writeFileSync(join(signed, 'index.json'), index);
    writeFileSync(
      join(signed, 'index.json.sig'),
      signatureFile(index, [secretKey(join(offline, 'online-2.secret'))]),
    );
    writeFileSync(join(signed, 'keys.json'), bytes);
    writeFileSync(join(signed, 'keys.json.sig'), sig);
    const read = async (path: string) => {
      const source = path.startsWith('packs/')
        ? join(input.layout ?? '', path)
        : join(signed, path);
      try {
        return new Uint8Array(readFileSync(source));
      } catch {
        return null;
      }
    };
    layout = await verifySignedLayout({ read, root, now: input.now, binaryVersion: null });
    pinnedLayout = await verifySignedLayout({
      read,
      root: PINNED_TRUST_ROOT,
      now: input.now,
      binaryVersion: null,
    });
    const ok = layout.packs.filter((p) => p.status === 'ok').length;
    console.log(
      `  throwaway root: ${layout.ok ? 'valid' : 'INVALID'} (${ok} of ${layout.packs.length} pack files verified)`,
    );
    console.log(
      `  pinned root: ${pinnedLayout.ok ? 'VALID (unexpected)' : `refused (${pinnedLayout.refusal?.reason})`}`,
    );
  }
  console.log(`\nDone. Delete ${input.dir} when you have read it.`);
  return {
    root,
    keysAccepted: accepted.ok,
    pinnedRefusal: pinned.ok ? null : pinned.error.reason,
    layout,
    pinnedLayout,
  };
}
