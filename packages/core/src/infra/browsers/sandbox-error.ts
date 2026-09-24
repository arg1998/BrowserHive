/** @module infra/browsers/sandbox-error — the typed `SANDBOX_UNAVAILABLE` error in its two forms: the boot refusal of `sandbox=on` (exit code 3) and the per-session tool error (`retryable: never`). */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { AppError } from '../../kernel/errors/app-error.ts';

/** Inputs of {@link sandboxUnavailable}. */
export interface SandboxUnavailableInput {
  readonly channel: string;
  /** Chrome's own one-line reason. */
  readonly reason: string;
  /** Who required the sandbox: the operator's `sandbox=on`, or an agent's `launch_options`. */
  readonly requiredBy: 'config' | 'launch_options';
  /** Channels checked to sandbox on this host. */
  readonly alternatives: readonly string[];
  /** Guidance lines: the short form for a tool error, the full block for the boot refusal. */
  readonly guidance: readonly string[];
  readonly executable?: string;
  readonly cause?: string;
  /** Replaces the first sentence (the boot refusal states that the sandbox was required). */
  readonly headline?: string;
  /** The launch error it came from (private; never projected). */
  readonly err?: unknown;
}

/**
 * Builds `SANDBOX_UNAVAILABLE`. The public message is the registry sentence (or `headline`), then
 * "Retrying will not help." for tool errors, then the short guidance, so an agent that only reads the
 * `[CODE] message` text still learns what to do.
 *
 * @returns The error.
 */
export function sandboxUnavailable(
  input: SandboxUnavailableInput,
): AppError<'SANDBOX_UNAVAILABLE'> {
  const details = {
    channel: input.channel,
    reason: input.reason,
    required_by: input.requiredBy,
    alternatives: [...input.alternatives],
    guidance: [...input.guidance],
    ...(input.executable !== undefined && { executable: input.executable }),
    ...(input.cause !== undefined && { cause: input.cause }),
  };
  const first =
    input.headline ?? renderMessage(ERROR_REGISTRY.SANDBOX_UNAVAILABLE.message, details);
  const publicMessage =
    input.headline !== undefined
      ? first
      : [first, 'Retrying will not help.', ...input.guidance].join(' ');
  return new AppError('SANDBOX_UNAVAILABLE', details, {
    publicMessage,
    ...(input.err !== undefined && { cause: input.err }),
  });
}
