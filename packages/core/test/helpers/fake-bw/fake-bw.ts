#!/usr/bin/env bun
/** @module test/helpers/fake-bw/fake-bw — a Bun script emulating `bw status/list/get/sync` for integration and e2e (spec 09 §4). BrowserHive never runs `bw unlock`. */

/*
 * Behaviour is driven by `$HOME/.fake-bw.json` (the adapter passes only PATH/HOME/BW_SESSION to
 * the child) with the same keys as the environment variables below, which override it:
 *   FAKE_BW_TOKEN       the only BW_SESSION the fake treats as unlocked (default `fake-session-token`);
 *                       any other value means "locked".
 *   FAKE_BW_VAULT       path to a JSON file `{ folders: [{id,name}], items: [bw item objects] }`;
 *                       absent → a built-in vault with one folder and two items.
 *   FAKE_BW_LOG         path to append one JSON line per invocation `{ argv, env_keys, stdin_len }`
 *                       (arg-shape and minimal-env assertions).
 *   FAKE_BW_SLEEP_MS    delay before answering (timeout tests).
 *   FAKE_BW_EXIT        force this exit code with `FAKE_BW_STDERR` on stderr (error mapping tests).
 */

import { appendFileSync, readFileSync } from 'node:fs';

interface BwFolder {
  readonly id: string;
  readonly name: string;
}
interface BwItem {
  readonly id: string;
  readonly name: string;
  readonly folderId?: string | null;
  readonly login?: {
    readonly username?: string;
    readonly password?: string;
    readonly totp?: string;
    readonly uris?: { readonly uri: string }[];
  } | null;
}
interface Vault {
  readonly folders: BwFolder[];
  readonly items: BwItem[];
}

const DEFAULT_VAULT: Vault = {
  folders: [{ id: 'f-work', name: 'Work' }],
  items: [
    {
      id: 'i-fixture',
      name: 'Fixture Login',
      folderId: 'f-work',
      login: {
        username: 'alice@example.com',
        password: 'S3cr3t-P@ssw0rd-xyz',
        uris: [{ uri: 'http://127.0.0.1/form' }, { uri: 'http://localhost/form' }],
      },
    },
    {
      id: 'i-nofolder',
      name: 'Ungrouped',
      folderId: '',
      login: { username: 'bob', password: 'hunter2pass', uris: [] },
    },
  ],
};

interface FakeConfig {
  readonly token?: string;
  readonly vault?: Vault;
  readonly log?: string;
  readonly sleepMs?: number;
  readonly exit?: { readonly code: number; readonly stderr: string };
}

const argv = process.argv.slice(2);

function loadConfig(): FakeConfig {
  const home = process.env['HOME'];
  if (home === undefined) return {};
  try {
    return JSON.parse(readFileSync(`${home}/.fake-bw.json`, 'utf8')) as FakeConfig;
  } catch {
    return {};
  }
}

const config = loadConfig();
const env: Record<string, string | undefined> = {
  ...(config.token !== undefined && { FAKE_BW_TOKEN: config.token }),
  ...(config.log !== undefined && { FAKE_BW_LOG: config.log }),
  ...(config.sleepMs !== undefined && { FAKE_BW_SLEEP_MS: String(config.sleepMs) }),
  ...(config.exit !== undefined && {
    FAKE_BW_EXIT: String(config.exit.code),
    FAKE_BW_STDERR: config.exit.stderr,
  }),
  ...process.env,
};

function out(value: unknown): void {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function loadVault(): Vault {
  const path = env['FAKE_BW_VAULT'];
  if (path === undefined) return config.vault ?? DEFAULT_VAULT;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) fail('bad FAKE_BW_VAULT');
  return parsed as Vault;
}

function handleList(words: readonly string[], flag: (name: string) => string | undefined): void {
  const vault = loadVault();
  if (words[1] === 'folders') {
    out(vault.folders);
    return;
  }
  if (words[1] === 'items') {
    const folderId = flag('--folderid');
    const search = flag('--search')?.toLowerCase();
    out(
      vault.items
        .filter((i) =>
          folderId === undefined
            ? true
            : folderId === 'null'
              ? !i.folderId
              : i.folderId === folderId,
        )
        .filter((i) => search === undefined || i.name.toLowerCase().includes(search))
        .map(({ login, ...rest }) => ({
          ...rest,
          login: login ? { uris: login.uris ?? [] } : null,
        })),
    );
    return;
  }
  fail(`Unknown list object: ${words[1] ?? ''}`);
}

async function main(): Promise<void> {
  const log = env['FAKE_BW_LOG'];
  if (log !== undefined) {
    appendFileSync(
      log,
      `${JSON.stringify({ argv, env_keys: Object.keys(env).sort(), has_session: env['BW_SESSION'] !== undefined })}\n`,
    );
  }
  const sleepMs = Number(env['FAKE_BW_SLEEP_MS'] ?? '0');
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  const forced = env['FAKE_BW_EXIT'];
  if (forced !== undefined) fail(env['FAKE_BW_STDERR'] ?? 'forced failure', Number(forced));

  const token = env['FAKE_BW_TOKEN'] ?? 'fake-session-token';
  const unlocked = env['BW_SESSION'] === token;
  // Global options (`--nointeraction`, `--raw`) may precede the command.
  const words = argv.filter((a) => a !== '--nointeraction' && a !== '--raw');
  const command = words[0];
  const positionals = (() => {
    const i = words.indexOf('--');
    return i >= 0 ? words.slice(i + 1) : [];
  })();
  const flag = (name: string): string | undefined => {
    const i = words.indexOf(name);
    return i >= 0 ? words[i + 1] : undefined;
  };

  switch (command) {
    case 'status':
      out({ status: unlocked ? 'unlocked' : 'locked' });
      return;
    case 'sync':
      if (!unlocked) fail('Vault is locked.');
      out('Syncing complete.');
      return;
    case 'list':
      if (!unlocked) fail('Vault is locked.');
      handleList(words, flag);
      return;
    case 'get': {
      if (!unlocked) fail('Vault is locked.');
      const vault = loadVault();
      const arg = positionals[0] ?? words[2] ?? '';
      const item = vault.items.find((i) => i.id === arg) ?? vault.items.find((i) => i.name === arg);
      if (item === undefined) fail('Not found.');
      out(item);
      return;
    }
    default:
      fail(`Unknown command: ${command ?? ''}`);
  }
}

await main();
