/** @module cli/commands/purge — `browserhive purge [--all] [--dryRun] [--yes]`: inventory first, a typed YES, a second YES for --all, refusal without a TTY; over the D-24 layout */

/*
 * Show before you destroy: the data root is not obvious and mixes things of very different value
 * (a cheap-to-lose database, merely inconvenient browser profiles, and saved auth states that may
 * hold irreplaceable logged-in sessions). Secrets are opt-in: `--all` is confirmed on its own terms.
 */
import {
  type DataDirInventory,
  type PurgeTarget,
  purge,
  purgeInventory,
} from '@browserhive/core/maintenance';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode } from '../invocation.ts';
import { size } from './common.ts';

/** The exact word the operator must type. Case-sensitive on purpose. */
export const PURGE_CONFIRM_WORD = 'YES';

/** Default targets: the database and the per-session directories (cheap to lose; secrets need `--all`). */
export const DEFAULT_TARGETS: readonly PurgeTarget[] = ['database', 'sessions'];
/** Targets added by `--all`. */
export const ALL_ONLY_TARGETS: readonly PurgeTarget[] = [
  'auth-states',
  'uploads',
  'backups',
  'admin',
];

const LABELS: Readonly<Record<PurgeTarget, string>> = {
  database:
    'Database (browserhive.db + WAL): events, sessions, vault bindings and policies, tokens',
  sessions: 'Session directories (traces, screenshots, downloads, browser profiles)',
  'auth-states': 'Saved auth states (logged-in profiles + storage snapshots)',
  uploads: 'Upload sandbox',
  backups: 'Database backups',
  admin: 'Dashboard credentials (the password is re-seeded on next start)',
};

interface Item {
  readonly target: PurgeTarget;
  readonly path: string;
  readonly bytes: number;
  readonly count: string;
  readonly detail: readonly { readonly label: string; readonly count: number }[];
  readonly present: boolean;
}

function items(inventory: DataDirInventory): readonly Item[] {
  const db = inventory.database;
  const list: Item[] = [
    {
      target: 'database',
      path: db?.path ?? `${inventory.dataDir}/browserhive.db`,
      bytes: db?.sizeBytes ?? 0,
      count:
        db === null
          ? 'missing'
          : db.error !== null
            ? `unreadable (${db.error})`
            : `${db.tables.reduce((n, t) => n + t.rows, 0).toLocaleString('en-US')} rows`,
      detail: db?.tables.map((t) => ({ label: t.table, count: t.rows })) ?? [],
      present: db !== null,
    },
  ];
  for (const dir of inventory.directories) {
    list.push({
      target: dir.name,
      path: dir.path,
      bytes: dir.sizeBytes,
      count: dir.exists ? `${dir.files.toLocaleString('en-US')} files` : 'missing',
      detail: [],
      present: dir.exists,
    });
  }
  return list;
}

/**
 * Renders the inventory block shown before the confirmation prompt.
 *
 * @returns The lines.
 */
export function renderPurgeInventory(
  inventory: DataDirInventory | null,
  options: {
    readonly dataDir: string;
    readonly all: boolean;
    readonly openSessions: number;
    readonly lockPid: number | null;
  },
): readonly string[] {
  const lines = ['', `BrowserHive data directory: ${options.dataDir}`];
  if (inventory === null) {
    lines.push('', 'Nothing to purge — that directory does not exist.');
    return lines;
  }
  const targets = options.all ? [...DEFAULT_TARGETS, ...ALL_ONLY_TARGETS] : DEFAULT_TARGETS;
  const all = items(inventory);
  const targeted = all.filter((item) => targets.includes(item.target));
  const kept = all.filter((item) => !targets.includes(item.target));
  lines.push('', 'WILL BE DELETED — PERMANENTLY, WITH NO UNDO:');
  for (const item of targeted) {
    lines.push(`  • ${LABELS[item.target]}`, `      ${item.path}`);
    lines.push(`      ${item.count}  ·  ${size(item.bytes)}`);
    for (const d of item.detail) {
      lines.push(`        ${d.label.padEnd(20)} ${d.count.toLocaleString('en-US')}`);
    }
  }
  const total = targeted.reduce((n, item) => n + item.bytes, 0);
  lines.push('', `  Total to reclaim: ${size(total)}`);
  if (kept.length > 0) {
    lines.push('', 'WILL BE KEPT (pass --all to include these too):');
    for (const item of kept) {
      lines.push(`  • ${LABELS[item.target]} — ${item.count}  ·  ${size(item.bytes)}`);
    }
  }
  if (options.lockPid !== null) {
    lines.push(
      '',
      `  ⚠  A BrowserHive process (pid ${options.lockPid}) holds this data directory. Stop it first —`,
      '     purging now would delete the database and browser profiles out from under it.',
    );
  }
  if (options.openSessions > 0) {
    lines.push(
      '',
      `  ⚠  ${options.openSessions} session(s) are still marked open. If a BrowserHive server is`,
      '     running, stop it first — purging now would delete browser profiles out from',
      '     under live sessions. (Open rows also persist after an unclean shutdown.)',
    );
  }
  if (options.all) {
    lines.push(
      '',
      '  ⚠  --all includes saved auth states: every logged-in profile snapshot is lost,',
      '     and any account without a recovery path will need to be signed into again.',
      '  ⚠  Vault bindings and group policies live in the database and are lost with it;',
      '     export them first from the dashboard (Vault → Export) if you need them.',
    );
  }
  return lines;
}

/**
 * Runs `purge`.
 *
 * @returns 0 purged (or dry run / nothing to do), 1 aborted, refused or failed.
 */
export async function runPurge(
  context: CommandContext,
  options: {
    readonly dataDir: string;
    readonly all: boolean;
    readonly dryRun: boolean;
    readonly yes: boolean;
  },
): Promise<ExitCode> {
  const { deps, out } = context;
  const { dataDir } = options;
  const root = await deps.fs.stat(dataDir);
  let openSessions = 0;
  const purgeDeps = {
    fs: deps.fs,
    readInventory: async (dbPath: string) => {
      const info = await deps.inspectDatabase(dbPath);
      const storage = await deps.openStorage({
        dataDir,
        readOnly: true,
        migrate: false,
        owner: 'purge',
      });
      try {
        const tables = await storage.tableCounts();
        openSessions = await storage.openSessionCount();
        const sizeBytes = (await deps.fs.stat(dbPath))?.sizeBytes ?? 0;
        return {
          path: dbPath,
          sizeBytes,
          schemaVersion: info?.userVersion ?? 0,
          tables,
          backups: [],
        };
      } finally {
        await storage.close();
      }
    },
  };
  const inventory = root?.isDirectory === true ? await purgeInventory(dataDir, purgeDeps) : null;
  const lockPid = deps.lock.read(dataDir)?.pid ?? null;
  out.lines(renderPurgeInventory(inventory, { dataDir, all: options.all, openSessions, lockPid }));
  if (inventory === null) return EXIT.ok;

  if (options.dryRun) {
    out.line();
    out.line('Dry run — nothing was deleted.');
    return EXIT.ok;
  }
  if (!options.yes) {
    if (deps.prompt === null) {
      out.diagnostic('');
      out.diagnostic(
        'browserhive purge: refusing to delete without confirmation, and stdin is not a terminal.',
      );
      out.diagnostic('Run it in a terminal, or pass --yes if you are scripting this deliberately.');
      return EXIT.fatal;
    }
    out.line();
    const answer = await deps.prompt(
      `Type ${PURGE_CONFIRM_WORD} to delete the above permanently: `,
    );
    if (answer.trim() !== PURGE_CONFIRM_WORD) {
      out.line('Aborted — nothing was deleted.');
      return EXIT.fatal;
    }
    if (options.all) {
      const second = await deps.prompt(
        'This also deletes saved logins, backups and the dashboard password. Type YES again to confirm: ',
      );
      if (second.trim() !== PURGE_CONFIRM_WORD) {
        out.line('Aborted — nothing was deleted.');
        return EXIT.fatal;
      }
    }
  }

  const targets = options.all ? [...DEFAULT_TARGETS, ...ALL_ONLY_TARGETS] : DEFAULT_TARGETS;
  const failed: string[] = [];
  let reclaimed = 0;
  out.line();
  for (const item of items(inventory).filter((candidate) => targets.includes(candidate.target))) {
    try {
      await purge(dataDir, [item.target], purgeDeps);
      reclaimed += item.bytes;
      if (item.present) out.line(`  deleted  ${LABELS[item.target]}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      failed.push(`${LABELS[item.target]}: ${reason}`);
    }
  }
  for (const failure of failed) out.diagnostic(`  FAILED   ${failure}`);
  out.line();
  if (failed.length > 0) {
    out.diagnostic(`browserhive purge: ${failed.length} item(s) could not be removed.`);
    return EXIT.fatal;
  }
  out.line(`Purged. ${size(reclaimed)} reclaimed from ${dataDir}`);
  return EXIT.ok;
}
