/** @module test/helpers/fake-bw — helpers to put the fake `bw` on a child's PATH and build its env (spec 09 §4). */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory containing the executable `bw` shim. */
export const FAKE_BW_DIR = dirname(fileURLToPath(import.meta.url));
/** The only `BW_SESSION` the fake treats as unlocked (what `bw unlock --raw` would have printed). */
export const FAKE_BW_TOKEN = 'fake-session-token';
/** The credential of the built-in `Fixture Login` item. */
export const FAKE_BW_FIXTURE = {
  itemId: 'i-fixture',
  itemName: 'Fixture Login',
  groupId: 'f-work',
  groupName: 'Work',
  username: 'alice@example.com',
  password: 'S3cr3t-P@ssw0rd-xyz',
} as const;

/** Options for {@link fakeBwEnv}. */
export interface FakeBwEnvOptions {
  /** Pre-exported session (`BW_SESSION`); omit to start locked. */
  readonly session?: string;
  /** Path of a JSON vault file; omit for the built-in vault. */
  readonly vaultPath?: string;
  /** Path the fake appends one JSON line per invocation to. */
  readonly logPath?: string;
  readonly sleepMs?: number;
  readonly forceExit?: { readonly code: number; readonly stderr: string };
  /** The real `PATH` to prepend the fake to (defaults to a bare fake-only PATH plus common bin dirs). */
  readonly basePath?: string;
  /** `HOME` for the child (where {@link writeFakeBwConfig} puts `.fake-bw.json`); default `/tmp`. */
  readonly home?: string;
}

/** `$HOME/.fake-bw.json` — the knobs that survive the adapter's minimal child env. */
export interface FakeBwConfig {
  readonly token?: string;
  readonly vault?: unknown;
  readonly log?: string;
  readonly sleepMs?: number;
  readonly exit?: { readonly code: number; readonly stderr: string };
}

/** Writes the fake's config into `home` so a child that only receives PATH/HOME/BW_SESSION still finds it. */
export async function writeFakeBwConfig(home: string, config: FakeBwConfig): Promise<void> {
  await writeFile(join(home, '.fake-bw.json'), JSON.stringify(config));
}

/** A `HostEnvironment.env`-shaped record with the fake `bw` first on `PATH`. */
export function fakeBwEnv(options: FakeBwEnvOptions = {}): Record<string, string> {
  const base = options.basePath ?? '/usr/local/bin:/usr/bin:/bin';
  return {
    PATH: `${FAKE_BW_DIR}:${base}`,
    HOME: options.home ?? '/tmp',
    ...(options.session !== undefined && { BW_SESSION: options.session }),
    ...(options.vaultPath !== undefined && { FAKE_BW_VAULT: options.vaultPath }),
    ...(options.logPath !== undefined && { FAKE_BW_LOG: options.logPath }),
    ...(options.sleepMs !== undefined && { FAKE_BW_SLEEP_MS: String(options.sleepMs) }),
    ...(options.forceExit !== undefined && {
      FAKE_BW_EXIT: String(options.forceExit.code),
      FAKE_BW_STDERR: options.forceExit.stderr,
    }),
  };
}
