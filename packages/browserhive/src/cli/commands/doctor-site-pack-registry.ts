/** @module cli/commands/doctor-site-pack-registry — the registry part of `doctor`'s `site packs` row (spec 13 §10.3, §10.9, §11.9, D-55), offline: the disclosure of the update check (or why none runs), the held index's expiry (`<dataDir>/site-packs/remote/index.json`), the client's last checks, failures and clock skew (the `meta` row `site_packs.client`), and the release's signed snapshot (`<bundled>/registry/v1/`) verified under the pinned root keys. Nothing is fetched or written. */
import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import { REGISTRY_INDEX_MAX_BYTES, RegistryIndexV1 } from '@browserhive/contracts/site-packs';
import {
  PINNED_TRUST_ROOT,
  type SignedLayoutReport,
  trustsNothing,
  verifySignedLayout,
} from '@browserhive/core/server';
import { z } from 'zod';
import type { CliDeps } from '../deps.ts';
import { formatTimestamp } from './common.ts';
import { skewText } from './sitepacks-registry.ts';
import { layoutReader } from './sitepacks-verify-layout.ts';

type Deps = Pick<CliDeps, 'fs' | 'clock' | 'sitePacksTrustRoot'>;

/** The default `sitePacksUrl`. */
const DEFAULT_URL = 'https://browserhive.ai/registry/v1/';
/** Clock skew `doctor` warns about (spec 13 §11.9). */
const SKEW_WARN_MS = 5 * 60_000;
/** Consecutive failures that record `SITE_PACKS_FETCH_FAILED` (spec 13 §10.3 step 4). */
const FAILURES_WARN = 3;

/** The `meta` row `site_packs.client` (written by the registry client). */
const ClientStatus = z.looseObject({
  last_check_at: z.number().nullable().optional(),
  last_ok_at: z.number().nullable().optional(),
  last_outcome: z.string().nullable().optional(),
  last_error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
  failures: z.number().int().nonnegative().optional(),
  clock_skew_ms: z.number().optional(),
});

/** What the registry facts add to the row. */
export interface RegistryFacts {
  readonly notes: string[];
  readonly warnings: string[];
  readonly failures: string[];
}

/** Inputs of {@link registryFacts}. */
export interface RegistryFactsInput {
  readonly dataDir: string;
  readonly config: ServerConfig | null;
  readonly bundledDir: string | undefined;
  readonly binaryVersion: string;
  /** The `site_packs.client` meta value, `null` when absent (no check yet, or no database). */
  readonly client: string | null;
}

/** The held index's version and expiry, from the last good copy the server keeps. */
async function heldIndex(
  deps: Deps,
  dataDir: string,
): Promise<{ version: number; expires: string } | 'unreadable' | null> {
  const path = join(dataDir, 'site-packs', 'remote', 'index.json');
  const stat = await deps.fs.stat(path).catch(() => null);
  if (stat === null || !stat.isFile) return null;
  if (stat.sizeBytes > REGISTRY_INDEX_MAX_BYTES) return 'unreadable';
  try {
    const bytes = await deps.fs.readBytes(path);
    const parsed = RegistryIndexV1.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success
      ? { version: parsed.data.version, expires: parsed.data.expires }
      : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** The client's status row, `null` when absent or not readable. */
function clientStatus(text: string | null): z.infer<typeof ClientStatus> | null {
  if (text === null) return null;
  try {
    const parsed = ClientStatus.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The snapshot's `issued_at` (epoch ms), read without trusting it (only to re-check an aged snapshot). */
async function issuedAt(deps: Deps, dir: string): Promise<number | null> {
  try {
    const bytes = await deps.fs.readBytes(join(dir, 'index.json'));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const issued = z.object({ issued_at: z.string() }).safeParse(value);
    if (!issued.success) return null;
    const ms = Date.parse(issued.data.issued_at);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function snapshotRefusal(report: SignedLayoutReport): string {
  if (report.refusal !== null) {
    return `${report.refusal.file}: ${report.refusal.reason} (${report.refusal.detail})`;
  }
  const bad = report.packs.filter((p) => p.status === 'absent' || p.status === 'refused');
  return bad.map((p) => `${p.id} v${p.version} ${p.status}`).join(', ') || 'not valid';
}

/**
 * The release's signed snapshot (spec 13 §10.9) under the pinned root. A snapshot ages past its
 * index's 14-day expiry; it then only sets the first rollback floors, so its signatures are checked
 * as of its own issue time.
 */
async function snapshotFacts(
  deps: Deps,
  input: RegistryFactsInput,
  facts: RegistryFacts,
): Promise<void> {
  if (input.bundledDir === undefined) return;
  const dir = join(input.bundledDir, 'registry', 'v1');
  const stat = await deps.fs.stat(dir).catch(() => null);
  if (stat?.isDirectory !== true) {
    facts.notes.push('no registry snapshot in this build');
    return;
  }
  const root = deps.sitePacksTrustRoot ?? PINNED_TRUST_ROOT;
  const verify = (now: number) =>
    verifySignedLayout({
      read: layoutReader(deps.fs, dir),
      root,
      now,
      binaryVersion: input.binaryVersion,
    });
  let report = await verify(deps.clock.now());
  let aged = false;
  const reason = report.refusal?.reason;
  if (!report.ok && (reason === 'expired' || reason === 'key_expired')) {
    const issued = await issuedAt(deps, dir);
    if (issued !== null) {
      const again = await verify(issued);
      if (again.ok) {
        report = again;
        aged = true;
      }
    }
  }
  if (!report.ok) {
    facts.failures.push(
      `the bundled registry snapshot does not verify: ${snapshotRefusal(report)}`,
    );
    return;
  }
  const version = report.index?.value.version ?? 0;
  facts.notes.push(
    aged
      ? `registry snapshot v${version} verifies (expired ${report.index?.value.expires ?? ''}; it only sets the first rollback floors)`
      : `registry snapshot v${version} verifies`,
  );
}

/**
 * The registry facts of the `site packs` row.
 *
 * @returns Notes (✓ detail), warnings and failures.
 */
export async function registryFacts(deps: Deps, input: RegistryFactsInput): Promise<RegistryFacts> {
  const facts: RegistryFacts = { notes: [], warnings: [], failures: [] };
  const root = deps.sitePacksTrustRoot ?? PINNED_TRUST_ROOT;
  const updateCheck = input.config?.sitePacksUpdateCheck ?? true;
  const url = input.config?.sitePacksUrl ?? DEFAULT_URL;
  // D-55's disclosure: what the one default outbound request does, or why none is made.
  if (!updateCheck) facts.notes.push('update check off: no request');
  else if (trustsNothing(root)) {
    facts.notes.push('this build pins no registry keys yet: no update check runs');
  } else {
    facts.notes.push(
      `checks ${url} every 24 h and downloads only the signed index; sends nothing about this install`,
    );
  }
  const now = deps.clock.now();
  const held = await heldIndex(deps, input.dataDir);
  if (held === 'unreadable') {
    facts.warnings.push('the held registry index (site-packs/remote/index.json) does not parse');
  } else if (held !== null) {
    const expires = Date.parse(held.expires);
    if (Number.isFinite(expires) && expires <= now) {
      facts.warnings.push(
        `the held registry index v${held.version} expired on ${formatTimestamp(expires)} (stale): nothing new is offered until a fresh one verifies; approved packs keep applying`,
      );
    } else {
      facts.notes.push(`registry index v${held.version} (expires ${formatTimestamp(expires)})`);
    }
  }
  const client = clientStatus(input.client);
  if (client !== null) {
    const skew = client.clock_skew_ms;
    if (skew !== undefined && Math.abs(skew) > SKEW_WARN_MS) {
      facts.warnings.push(
        `this machine's clock is ${skewText(skew)} the registry's: fix the system clock (index expiry is judged by it)`,
      );
    }
    const failures = client.failures ?? 0;
    const error = client.last_error ?? null;
    if (failures >= FAILURES_WARN) {
      facts.warnings.push(
        `the last ${failures} update checks failed${error === null ? '' : `: [${error.code}] ${error.message}`}`,
      );
    } else if (failures > 0 && error !== null) {
      facts.notes.push(`last update check failed: [${error.code}]`);
    }
    if (client.last_ok_at != null) {
      facts.notes.push(`last good check ${formatTimestamp(client.last_ok_at)}`);
    }
  }
  await snapshotFacts(deps, input, facts);
  return facts;
}
