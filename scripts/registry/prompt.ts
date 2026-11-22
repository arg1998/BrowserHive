/** @module scripts/registry/prompt — passphrases and confirmations for `registry-keys.ts`: typed on the terminal without echo, or read from `--passphrase-file` (tests and the dry run). Never from an argument or an environment variable, which shells and process lists keep. */

import { readFileSync } from 'node:fs';

/** Where passphrases come from. */
export interface Prompter {
  /** A passphrase; `confirm` asks twice and compares. */
  passphrase(label: string, confirm: boolean): Promise<string>;
  /** `true` when the owner typed `yes`. */
  yes(question: string): Promise<boolean>;
}

/** Shortest passphrase accepted for a real root key. */
export const MIN_PASSPHRASE = 12;

function hidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolve(value);
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          done();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function line(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    const onData = (chunk: string): void => {
      stdin.off('data', onData);
      stdin.pause();
      resolve(chunk.split('\n')[0]?.trim() ?? '');
    };
    stdin.on('data', onData);
  });
}

/**
 * The prompter of a run: from `passphraseFile` (its first line, for every passphrase; questions
 * answer yes) or the terminal.
 *
 * @throws Without a file and without a terminal.
 */
export function prompter(passphraseFile: string | null, minLength: number): Prompter {
  if (passphraseFile !== null) {
    const value = readFileSync(passphraseFile, 'utf8').split('\n')[0] ?? '';
    if (value.length < minLength)
      throw new Error(`the passphrase must be at least ${minLength} characters`);
    return { passphrase: async () => value, yes: async () => true };
  }
  if (!process.stdin.isTTY) {
    throw new Error('passphrases are typed on a terminal (or given with --passphrase-file)');
  }
  return {
    async passphrase(label, confirm) {
      for (;;) {
        const first = await hidden(`${label}: `);
        if (first.length < minLength) {
          console.log(`  at least ${minLength} characters, please`);
          continue;
        }
        if (!confirm) return first;
        if ((await hidden(`${label} (again): `)) === first) return first;
        console.log('  the two did not match; again');
      }
    },
    async yes(question) {
      return (await line(`${question} Type yes to go on: `)) === 'yes';
    },
  };
}
