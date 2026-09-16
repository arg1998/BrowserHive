/** @module cli/output/process-io — the real process streams and the TTY prompt (the only place the CLI touches `process.stdout`, `process.stderr` and `process.stdin`) */
import { createInterface } from 'node:readline';

/** Writers and terminal facts of the running process. */
export interface ProcessStreams {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly isTty: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean };
  /** stdout columns when it is a terminal. */
  readonly columns: number | undefined;
}

/**
 * The process's standard streams.
 *
 * @returns Writers bound to `process.stdout`/`process.stderr` and their TTY facts.
 */
export function processStreams(): ProcessStreams {
  return {
    stdout: (chunk) => {
      process.stdout.write(chunk);
    },
    stderr: (chunk) => {
      process.stderr.write(chunk);
    },
    isTty: {
      stdin: process.stdin.isTTY === true,
      stdout: process.stdout.isTTY === true,
      stderr: process.stderr.isTTY === true,
    },
    columns: process.stdout.isTTY === true ? process.stdout.columns : undefined,
  };
}

/** Asks one question and resolves with the exact answer typed. */
export type Prompter = (question: string) => Promise<string>;

/**
 * A readline prompt on the controlling terminal. The question is written to stderr so that
 * `browserhive purge > inventory.txt` still shows the question.
 *
 * @returns The prompter.
 */
export function terminalPrompter(): Prompter {
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await new Promise<string>((resolve) => {
        rl.question(question, resolve);
      });
    } finally {
      rl.close();
    }
  };
}
