/** @module scripts/registry-keys — the owner's offline tool for the site-pack registry keys (spec 13 §10.2, §10.7; the key ceremony in docs/contributing/registry.md). It never touches the network. Private keys are written only to the paths you name, which must be outside any git working tree, as new files with mode 0600; public files go to `registry/keys/` and the pinned list in `trust-root.ts`.
 *
 *   bun scripts/registry-keys.ts init-roots --out <dir>                 the two root keys (once)
 *   bun scripts/registry-keys.ts online-key --root <root-N.key> --secret-out <file> [--days 90] [--keys-days 120]
 *   bun scripts/registry-keys.ts sign-keys  --root <root-N.key> [--keys-days 120] [--index-floor <n>]
 *   bun scripts/registry-keys.ts revoke     --root <root-N.key> --key-id <id> [--keys-days 120]
 *   bun scripts/registry-keys.ts status
 *   bun scripts/registry-keys.ts dry-run [--out <empty dir>] [--layout <dir from registry-build.ts>]
 *
 * `--passphrase-file <file>` reads the passphrase instead of prompting (tests); `--repo <dir>`
 * works on another checkout.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PINNED_TRUST_ROOT, verifyKeys } from '@browserhive/core/server';
import { pinnedKeysIn } from './registry/check.ts';
import { dryRun } from './registry/dry-run.ts';
import { readRootKeyFile } from './registry/keyfile.ts';
import {
  addOnlineKey,
  initRoots,
  type KeyPaths,
  loadRoots,
  readKeys,
  resignKeys,
} from './registry/keys-ops.ts';
import { MIN_PASSPHRASE, prompter } from './registry/prompt.ts';
import { DAY_MS, readRootKeys } from './registry-common.mjs';

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

function need(name: string): string {
  const value = flag(name);
  if (value === null) throw new Error(`--${name} <value> is required`);
  return value;
}

function numberFlag(name: string, fallback: number): number {
  const value = flag(name);
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be a whole number`);
  return n;
}

/** Refuses a private-key path (a file, or a directory with `dir`) inside a git working tree, where it could be committed. */
function outsideGit(path: string, dir = false): string {
  const full = resolve(path);
  let at = dir ? full : dirname(full);
  while (!existsSync(at)) at = dirname(at);
  let inside = false;
  try {
    inside =
      execFileSync('git', ['-C', at, 'rev-parse', '--is-inside-work-tree'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString('utf8')
        .trim() === 'true';
  } catch {
    inside = false;
  }
  if (inside) {
    throw new Error(
      `${full} is inside a git working tree; keep private keys elsewhere (an offline drive)`,
    );
  }
  return full;
}

const repo = resolve(flag('repo') ?? join(import.meta.dir, '..'));
const paths: KeyPaths = {
  pubDir: join(repo, 'registry', 'keys'),
  trustRoot: join(repo, 'packages', 'core', 'src', 'infra', 'site-packs', 'trust-root.ts'),
  test: false,
};
const now = Date.now();
const keysDays = (): number => numberFlag('keys-days', 120);

async function unlockRoot() {
  const file = need('root');
  const ask = prompter(flag('passphrase-file'), MIN_PASSPHRASE);
  const root = readRootKeyFile(file, await ask.passphrase(`Passphrase of ${file}`, false));
  if (root.test) throw new Error(`${file} is a throwaway dry-run key`);
  console.log(`Unlocked root key ${root.slot} (${root.keyId}).`);
  return root;
}

function printKeys(keys: {
  version: number;
  expires: string;
  online: readonly { key_id: string; not_after: string }[];
}) {
  const left = (iso: string) => `${Math.floor((Date.parse(iso) - now) / DAY_MS)} days left`;
  console.log(`keys.json version ${keys.version}, expires ${keys.expires} (${left(keys.expires)})`);
  for (const k of keys.online)
    console.log(`  online key ${k.key_id} valid until ${k.not_after} (${left(k.not_after)})`);
}

const NEXT_PR =
  'Next: commit registry/keys/keys.json and keys.json.sig in a pull request (CODEOWNERS: you) and merge it; the next signing run uses them.';

async function main(): Promise<void> {
  switch (command) {
    case 'init-roots': {
      const out = outsideGit(need('out'), true);
      mkdirSync(out, { recursive: true, mode: 0o700 });
      if (readdirSync(out).some((n) => /^root-[12]\.key$/.test(n)))
        throw new Error(`${out} already holds root keys`);
      const ask = prompter(flag('passphrase-file'), MIN_PASSPHRASE);
      if (
        argv.includes('--replace') &&
        !(await ask.yes(
          'Replacing the roots needs a release; installs keep trusting the old ones until they upgrade.',
        ))
      )
        return;
      console.log(
        'Each root key is encrypted with its own passphrase. Write both down and keep them apart from the key files.',
      );
      const p1 = await ask.passphrase('Passphrase for root key 1', true);
      const p2 = await ask.passphrase('Passphrase for root key 2', true);
      const made = initRoots(paths, out, [p1, p2], now, argv.includes('--replace'));
      for (const k of made) {
        readRootKeyFile(k.file, k.slot === 1 ? p1 : p2);
        console.log(
          `Root key ${k.slot}: ${k.keyId} -> ${k.file} (encrypted; read back and checked)`,
        );
      }
      console.log(
        'Wrote registry/keys/root-1.pub, root-2.pub and the pinned list in trust-root.ts.',
      );
      console.log(
        'Next: copy the two .key files to two offline drives kept apart; commit the .pub files and trust-root.ts in a pull request; then run online-key.',
      );
      return;
    }
    case 'online-key': {
      const secretOut = outsideGit(need('secret-out'));
      const root = await unlockRoot();
      const made = addOnlineKey(paths, root, secretOut, numberFlag('days', 90), {
        now,
        keysDays: keysDays(),
      });
      console.log(`New online key ${made.keyId}, valid until ${made.notAfter}.`);
      printKeys(made.keys);
      console.log(
        `The secret value is in ${secretOut} (mode 0600). Put it into the environment secret, then delete the file:`,
      );
      console.log(
        `  gh secret set REGISTRY_ONLINE_KEY --env registry-signing < '${secretOut}' && shred -u '${secretOut}'`,
      );
      console.log(NEXT_PR);
      return;
    }
    case 'sign-keys':
    case 'revoke': {
      const root = await unlockRoot();
      const floor = flag('index-floor');
      const keys = resignKeys(paths, root, {
        now,
        keysDays: keysDays(),
        ...(floor !== null && { indexFloor: numberFlag('index-floor', 0) }),
        ...(command === 'revoke' && { revoke: need('key-id') }),
      });
      printKeys(keys);
      if (command === 'revoke')
        console.log(
          'Also delete REGISTRY_ONLINE_KEY if it held the revoked key, and add a new key (online-key).',
        );
      console.log(NEXT_PR);
      return;
    }
    case 'status': {
      const roots = readRootKeys(paths.pubDir);
      if (roots.placeholder)
        console.log('Root keys: placeholders (run init-roots in the key ceremony).');
      for (const k of roots.keys)
        console.log(`Root key ${k.slot}: ${k.key_id}${k.test ? ' (TEST)' : ''}`);
      for (const p of roots.problems) console.log(`Problem: ${p}`);
      const pinned =
        pinnedKeysIn(repo)
          .map((k) => k.keyId)
          .sort()
          .join(', ') || 'none';
      console.log(`Pinned in trust-root.ts: ${pinned}`);
      if (!roots.placeholder && roots.keys.length === 2) {
        const keys = readKeys(paths, loadRoots(paths));
        if (keys === null) console.log('keys.json: none yet (run online-key).');
        else {
          printKeys(keys);
          const bytes = new Uint8Array(readFileSync(join(paths.pubDir, 'keys.json')));
          const sig = new Uint8Array(readFileSync(join(paths.pubDir, 'keys.json.sig')));
          const checked = verifyKeys({ bytes, sig, root: PINNED_TRUST_ROOT, now, floor: null });
          console.log(
            checked.ok
              ? 'This build accepts keys.json.'
              : `This build refuses keys.json: ${checked.error.reason} (${checked.error.detail})`,
          );
        }
      }
      return;
    }
    case 'dry-run': {
      const given = flag('out');
      const dir =
        given === null
          ? mkdtempSync(join(tmpdir(), 'bh-registry-dry-run-'))
          : outsideGit(given, true);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
      const trustRoot = join(dir, 'trust-root.ts');
      copyFileSync(paths.trustRoot ?? '', trustRoot);
      const layout = flag('layout');
      await dryRun({ dir, trustRoot, now, layout: layout === null ? null : resolve(layout) });
      return;
    }
    default:
      console.log(
        readFileSync(import.meta.path, 'utf8')
          .split('*/')[0]
          ?.replace(/^\/\*\*\s*@module\s*/, '')
          .replace(/^ \* ?/gm, '') ?? '',
      );
      process.exit(command === undefined ? 0 : 64);
  }
}

main().catch((error: unknown) => {
  console.error(`registry-keys: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
