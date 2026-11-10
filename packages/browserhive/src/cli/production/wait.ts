/** @module cli/production/wait — the real `OperatorWait`: `setTimeout`, one stdin line through `node:readline` (terminal or pipe) and the process's SIGINT */
import { createInterface } from 'node:readline';
import type { LineRead, OperatorWait } from '../deps.ts';

/**
 * Reads one line of `process.stdin`. `terminal: false` keeps the terminal in cooked mode, so
 * Ctrl+C still raises SIGINT for {@link OperatorWait.onInterrupt} and a piped `\n` counts as Enter.
 *
 * @returns The pending read.
 */
function readStdinLine(): LineRead {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let settled = false;
  const line = new Promise<string | null>((resolve) => {
    rl.once('line', (text) => {
      settled = true;
      rl.close();
      resolve(text);
    });
    rl.once('close', () => {
      if (!settled) resolve(null);
    });
  });
  return {
    line,
    cancel: () => {
      settled = true;
      rl.close();
    },
  };
}

/**
 * The process's timers, stdin and SIGINT.
 *
 * @returns The production {@link OperatorWait}.
 */
export function processWait(): OperatorWait {
  return {
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    readLine: readStdinLine,
    onInterrupt: (listener) => {
      process.on('SIGINT', listener);
      return () => {
        process.off('SIGINT', listener);
      };
    },
  };
}
