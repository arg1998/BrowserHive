/** @module domain/policies/launch-options — validated Playwright launch/context option pass-through: deny-list, unsafe sibling fields, managed-dir guard (spec 11 §4). */

import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import { z } from 'zod';
import { assertLaunchArgsAllowed } from '../../kernel/deny-list.ts';
import { AppError } from '../../kernel/errors/app-error.ts';

/**
 * Loose fields that bypass the intent of the deny-list and are refused with `UNSAFE_LAUNCH_ARG`
 * naming the field (spec 11 §4): `env` leaks the host environment into the browser, `downloadsPath`
 * escapes the managed session directory, `recordVideo` writes outside it. `chromiumSandbox: false`
 * is checked separately (only the `false` value is unsafe).
 */
export const UNSAFE_LAUNCH_OPTION_FIELDS: readonly string[] = [
  'env',
  'downloadsPath',
  'recordVideo',
];

const looseRecord = z.looseObject({});

/** Everything Playwright accepts, with the caller's keys forwarded verbatim (D-12 pass-through). */
export type ParsedLaunchOptions = LaunchOptions & Readonly<Record<string, unknown>>;
/** Everything Playwright accepts for a context, forwarded verbatim. */
export type ParsedContextOptions = BrowserContextOptions & Readonly<Record<string, unknown>>;

function unsafe(field: string): AppError<'UNSAFE_LAUNCH_ARG'> {
  return new AppError(
    'UNSAFE_LAUNCH_ARG',
    { arg: field },
    {
      publicMessage: `Launch arg '${field}' is on the deny-list and would break session isolation.`,
    },
  );
}

/** Reads `args` as a string list when present (the tool schema already typed it). */
export function launchArgsOf(
  options: Readonly<Record<string, unknown>> | undefined,
): readonly string[] | undefined {
  const args = options?.['args'];
  if (!Array.isArray(args)) return undefined;
  return args.filter((a): a is string => typeof a === 'string');
}

/**
 * Validates the `launch_options` pass-through before any browser spawns.
 *
 * @throws `UNSAFE_LAUNCH_ARG` for a deny-listed `args` entry or an unsafe sibling field.
 */
export function parseLaunchOptions(input: unknown): ParsedLaunchOptions | undefined {
  if (input === undefined || input === null) return undefined;
  const parsed = looseRecord.parse(input);
  assertLaunchArgsAllowed(launchArgsOf(parsed));
  for (const field of UNSAFE_LAUNCH_OPTION_FIELDS) {
    if (parsed[field] !== undefined) throw unsafe(field);
  }
  if (parsed['chromiumSandbox'] === false) throw unsafe('chromiumSandbox');
  return parsed;
}

/** Validates the `context_options` pass-through (shape only; cross-mode rules live in create-request). */
export function parseContextOptions(input: unknown): ParsedContextOptions | undefined {
  if (input === undefined || input === null) return undefined;
  return looseRecord.parse(input);
}

/** True if the caller tried to set `userDataDir` through the launch-options pass-through. */
export function hasUserDataDir(options: ParsedLaunchOptions | undefined): boolean {
  return options !== undefined && options['userDataDir'] !== undefined;
}

/** The `storageState` value when it is a **string** (a saved-auth name); `undefined` for inline state objects. */
export function storageStateName(options: ParsedContextOptions | undefined): string | undefined {
  const value = options?.['storageState'];
  return typeof value === 'string' ? value : undefined;
}

/** The caller's `executablePath`, if any. */
export function executablePathOf(options: ParsedLaunchOptions | undefined): string | undefined {
  const value = options?.['executablePath'];
  return typeof value === 'string' ? value : undefined;
}
