/** @module app/config/removed-keys — removed keys in every source (spec 08 §5.10): a value that asked for what is now the only behaviour warns and is ignored; any other value is a usage error */
import {
  lookupKey,
  type ProvenanceSource,
  REMOVED_CONFIG_KEYS,
  type RemovedConfigKey,
} from '@browserhive/contracts/config';
import type { ConfigProblem } from './failure.ts';
import { quoteRaw } from './kinds.ts';

/** Where a removed key was set, and how that reads in a message. */
export interface RemovedKeyLocation {
  readonly source: ProvenanceSource;
  /** `--stealthDriver`, `BROWSERHIVE_STEALTH_DRIVER`, `file:/path#stealthDriver`, `options.stealthDriver`. */
  readonly location: string;
  /** `--stealthDriver`, `'stealthDriver' in /path`. */
  readonly display: string;
}

/** What a collector gathers. */
export interface FindingSink {
  readonly problems: ConfigProblem[];
  readonly warnings: string[];
}

/**
 * The answer to a removed key set to `raw`: a warning for a value that asked for what is now the
 * only behaviour; the removal hint for a value the key had; and, for a value the key never had (a
 * typo such as `PATCHRIGHT`), a message that says so instead of blaming the removal.
 *
 * @returns The problem, or the warning.
 */
export function removedKeyFinding(
  found: { readonly key: string; readonly removed: RemovedConfigKey },
  raw: unknown,
  where: RemovedKeyLocation,
): { readonly problem: ConfigProblem } | { readonly warning: string } {
  const { key, removed } = found;
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof value === 'string' && removed.accepted.includes(value)) {
    return {
      warning: `${where.display} is deprecated and ignored: ${removed.reason}. Remove it; from ${removed.unknownFrom} it is an unknown key.`,
    };
  }
  const known = typeof value === 'string' && removed.values.includes(value);
  return {
    problem: {
      code: 'CONFIG_INVALID',
      key,
      source: where.source,
      location: where.location,
      message: known
        ? `${where.display}: ${removed.instead}`
        : `${where.display}: ${quoteRaw(raw)} is not a value '${key}' ever had, and '${key}' itself is gone: ${removed.reason}. Remove '${key}'.`,
    },
  };
}

/** Adds the answer for one removed key to `sink`. */
export function addRemovedKey(
  found: { readonly key: string; readonly removed: RemovedConfigKey },
  raw: unknown,
  where: RemovedKeyLocation,
  sink: FindingSink,
): void {
  const finding = removedKeyFinding(found, raw, where);
  if ('problem' in finding) sink.problems.push(finding.problem);
  else sink.warnings.push(finding.warning);
}

/**
 * Removed keys a JavaScript caller may still pass to `createServer` (typed callers cannot: the
 * options are keyed by the current keys).
 *
 * @returns The problems and warnings.
 */
export function collectRemovedOverrides(overrides: object): FindingSink {
  const sink: FindingSink = { problems: [], warnings: [] };
  const extra: Readonly<Record<string, unknown>> = overrides as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(REMOVED_CONFIG_KEYS)) {
    const raw = extra[key];
    const found = lookupKey('json', key);
    if (raw === undefined || found.kind !== 'removed') continue;
    const location = `options.${key}`;
    addRemovedKey(found, raw, { source: 'cli', location, display: location }, sink);
  }
  return sink;
}
