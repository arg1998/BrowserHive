/** @module infra/process/bun-process-runner — `ProcessRunner` over `Bun.spawn`: bounded lifetime, captured output, EPIPE-tolerant stdin. */

import {
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
  ProcessSpawnError,
} from '../../ports/process-runner.ts';

/** Default cap on captured bytes per stream. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

type PipedSubprocess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Collects a stream up to `maxBytes`; resolves `true` when the cap was hit. */
async function collect(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onOverflow: () => void,
): Promise<string> {
  if (stream === null) return '';
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let seen = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      parts.push(decoder.decode(value, { stream: true }));
      if (seen > maxBytes) {
        onOverflow();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  parts.push(decoder.decode());
  return parts.join('');
}

/** The production runner. The only `Bun.spawn` site in core. */
export function createBunProcessRunner(): ProcessRunner {
  return {
    async run(command, args, options): Promise<ProcessRunResult> {
      let proc: PipedSubprocess;
      try {
        proc = Bun.spawn([command, ...args], {
          env: { ...options.env },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch (err) {
        const code = errnoCode(err);
        throw new ProcessSpawnError(code === 'ENOENT' ? 'not_found' : 'spawn_failed', command, err);
      }
      return finish(proc, options);
    },
  };
}

async function finish(
  proc: PipedSubprocess,
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  let timedOut = false;
  const kill = (): void => {
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  const onAbort = (): void => kill();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) kill();

  // stdin: a child that exits before reading (EPIPE) must not fail the call.
  try {
    if (options.stdin !== undefined) proc.stdin.write(options.stdin);
    await Promise.resolve(proc.stdin.end()).catch(() => undefined);
  } catch {
    // EPIPE or closed sink — ignored by contract.
  }

  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  try {
    const [stdout, stderr, code] = await Promise.all([
      collect(proc.stdout, maxBytes, kill),
      collect(proc.stderr, maxBytes, kill),
      proc.exited,
    ]);
    return { code: proc.signalCode !== null ? null : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
