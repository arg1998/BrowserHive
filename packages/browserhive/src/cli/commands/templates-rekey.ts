/** @module cli/commands/templates-rekey — `browserhive templates rekey --oldKeyEnv <ENV>`: re-encrypts every template checkpoint and version file with the current key, locally with the server stopped, and records each version's new file facts in its row (spec 13 §2.4). Repeatable: files already on the current key are skipped and their rows reconciled. */
import { join } from 'node:path';
import type { TemplateKey } from '@browserhive/core/server';
import type { CliStorage, CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation } from '../invocation.ts';
import { databaseExists, refuseWhileLocked } from './common.ts';

type RekeyInvocation = Extract<Invocation, { readonly command: 'templates-rekey' }>;
type Server = typeof import('@browserhive/core/server');

/** The keys of one run; never printed. */
interface RekeyKeys {
  readonly old: TemplateKey;
  readonly current: TemplateKey;
  readonly previous: TemplateKey | null;
}

/** What happened to one template's files. */
interface TemplateTally {
  readonly templateId: string;
  rewritten: number;
  skipped: number;
  failed: number;
}

function refuse(context: CommandContext, lines: readonly string[]): ExitCode {
  for (const line of lines) context.out.diagnostic(line);
  return EXIT.fatal;
}

function keyFrom(server: Server, text: string | null): TemplateKey | null {
  if (text === null) return null;
  const bytes = server.decodeTemplateKey(text);
  return bytes === null ? null : server.templateKeyOf(bytes);
}

/**
 * The old key from `<ENV>`, the current key (`templateKey`, else `admin/template.key`, never
 * created here) and `templateKeyPrevious`. Refusals name variables and paths, never a key.
 */
async function resolveKeys(
  context: CommandContext,
  server: Server,
  invocation: RekeyInvocation,
): Promise<RekeyKeys | ExitCode> {
  const { deps } = context;
  const env = invocation.oldKeyEnv;
  const oldText = deps.env[env];
  if (oldText === undefined || oldText.trim() === '') {
    return refuse(context, [
      `browserhive templates rekey: ${env} is not set. Export the old key (base64 of 32 bytes) in ${env} and run it again.`,
    ]);
  }
  const old = keyFrom(server, oldText);
  if (old === null) {
    return refuse(context, [
      `browserhive templates rekey: ${env} does not hold a template key (base64 of exactly 32 bytes).`,
    ]);
  }
  let current = keyFrom(server, invocation.templateKey);
  if (current === null) {
    const path = server.templateKeyPath(invocation.dataDir);
    const text = (await deps.fs.stat(path)) === null ? null : await deps.fs.readFile(path);
    current = keyFrom(server, text);
    if (current === null) {
      return refuse(context, [
        `browserhive templates rekey: no current key. ${text === null ? `templateKey is not set and ${path} does not exist` : `${path} does not hold a template key`}.`,
        'Set the new key in BROWSERHIVE_TEMPLATE_KEY (templateKey) or restore the key file; rekey never creates a key.',
      ]);
    }
  }
  if (current.keyId === old.keyId) {
    return refuse(context, [
      `browserhive templates rekey: ${env} holds the current key, so there is nothing to re-encrypt.`,
      'Set the new key as templateKey (BROWSERHIVE_TEMPLATE_KEY) and pass the old one in --oldKeyEnv.',
    ]);
  }
  return { old, current, previous: keyFrom(server, invocation.templateKeyPrevious) };
}

/** Runs `fn` with the database open for writing (it holds the data-dir lock), or with the lock alone. */
async function withRows<T>(
  context: CommandContext,
  dataDir: string,
  fn: (storage: CliStorage | null) => Promise<T>,
): Promise<T> {
  const { deps } = context;
  const owner = 'templates rekey';
  if (!(await databaseExists(deps, dataDir))) {
    const lock = deps.lock.acquire(dataDir, owner);
    try {
      return await fn(null);
    } finally {
      lock.release();
    }
  }
  const storage = await deps.openStorage({ dataDir, readOnly: false, migrate: true, owner });
  try {
    return await fn(storage);
  } finally {
    await storage.close();
  }
}

function tallyText(tally: TemplateTally): string {
  const parts = [`${tally.rewritten} re-encrypted`, `${tally.skipped} already on the current key`];
  if (tally.failed > 0) parts.push(`${tally.failed} failed`);
  return parts.join(', ');
}

/**
 * `templates rekey --oldKeyEnv <ENV>` (spec 13 §2.4): refuses while a server holds the data
 * directory, then rewrites every file not yet on the current key and updates its version row.
 *
 * @returns 0 when every file is on the current key, 1 when one failed or on a refusal, 3 while
 * the data directory is in use.
 */
export async function runTemplatesRekey(
  context: CommandContext,
  invocation: RekeyInvocation,
): Promise<ExitCode> {
  const { out } = context;
  const { dataDir } = invocation;
  const locked = refuseWhileLocked(context, dataDir, 're-encrypt the template files');
  if (locked !== null) return locked;
  const server: Server = await import('@browserhive/core/server');
  const keys = await resolveKeys(context, server, invocation);
  if (typeof keys === 'number') return keys;
  const store = new server.FileTemplateStateStore({
    templatesDir: join(dataDir, 'templates'),
    keys: { current: keys.current, previous: keys.previous },
  });
  const tallies: TemplateTally[] = [];
  const names = new Map<string, string>();
  const print = (tally: TemplateTally | undefined): void => {
    if (tally === undefined || invocation.json) return;
    const name = names.get(tally.templateId);
    const label = name === undefined ? tally.templateId : `${name} (${tally.templateId})`;
    out.status(tally.failed > 0 ? 'fail' : 'ok', label, tallyText(tally));
  };
  const result = await withRows(context, dataDir, async (storage) => {
    for (const row of (await storage?.templateRows()) ?? []) names.set(row.templateId, row.name);
    return server.rekeyTemplateFiles({
      store,
      current: keys.current,
      old: keys.old,
      updateRow: async (templateId, version, file) => {
        await storage?.updateTemplateVersionFile(templateId, version, file);
      },
      onFile: ({ templateId, outcome }) => {
        let tally = tallies.at(-1);
        if (tally?.templateId !== templateId) {
          print(tally);
          tally = { templateId, rewritten: 0, skipped: 0, failed: 0 };
          tallies.push(tally);
        }
        tally[outcome] += 1;
      },
    });
  });
  print(tallies.at(-1));
  if (invocation.json) {
    out.json({
      rewritten: result.rewritten,
      skipped: result.skipped,
      failed: result.failed.map((f) => ({
        template_id: f.templateId,
        slot: f.slot,
        reason: f.reason,
      })),
      templates: tallies.map((t) => ({
        template_id: t.templateId,
        name: names.get(t.templateId) ?? null,
        rewritten: t.rewritten,
        skipped: t.skipped,
        failed: t.failed,
      })),
    });
    return result.failed.length > 0 ? EXIT.fatal : EXIT.ok;
  }
  for (const failure of result.failed) {
    out.diagnostic(`  ${failure.templateId} ${String(failure.slot)}: ${failure.reason}`);
  }
  if (tallies.length === 0) {
    out.line('No template files to re-encrypt.');
    return EXIT.ok;
  }
  out.line();
  out.line(
    `${result.rewritten} file(s) re-encrypted, ${result.skipped} already on the current key, ${result.failed.length} failed.`,
  );
  if (result.failed.length > 0) {
    out.diagnostic(
      'browserhive templates rekey: some files could not be re-encrypted; fix the cause and run it again (it skips the files already done).',
    );
    return EXIT.fatal;
  }
  out.line('Every template file is on the current key; templateKeyPrevious is no longer needed.');
  return EXIT.ok;
}
