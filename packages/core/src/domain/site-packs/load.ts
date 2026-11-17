/** @module domain/site-packs/load — turns the bytes of one pack file into a checked pack version: size cap, JSON, known strategies, the `SitePackV1` schema, `refinePack()`, and the client range (spec 13 §9.2, §10.3 step 3). Every source and `sitepacks verify` use it. */

import { createHash } from 'node:crypto';
import { SITE_PACK_MAX_BYTES, SitePackV1, STRATEGY_IDS } from '@browserhive/contracts/site-packs';
import { z } from 'zod';
import { err, ok, type Result } from '../../kernel/result.ts';
import type { SkippedPackVersion, SourcePackVersion } from '../../ports/site-packs.ts';
import { compareSemver, type PackIssue, refinePack } from './refine.ts';

/** What {@link loadPackBytes} needs besides the bytes. */
export interface LoadPackOptions {
  /** Shown in reports: the release a bundled pack came with, or a local file's path. */
  readonly origin: string;
  /** This binary's version, checked against `min_client`/`max_client`; `null` skips the check (`verify`). */
  readonly binaryVersion: string | null;
  /** The id the file name promises (`<pack id>.json`); `null` when the name carries none. */
  readonly expectedId: string | null;
}

/** A refused version with its issues (for `SITE_PACK_INVALID` and `sitepacks verify`). */
export interface RefusedPack extends SkippedPackVersion {
  readonly issues: readonly PackIssue[];
}

const KNOWN_STRATEGIES: ReadonlySet<string> = new Set(STRATEGY_IDS);

/** SHA-256 of `bytes` as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Checks one pack file. Never throws. */
export function loadPackBytes(
  bytes: Uint8Array,
  options: LoadPackOptions,
): Result<SourcePackVersion, RefusedPack> {
  const fallbackId = options.expectedId ?? options.origin;
  const refuse = (
    reason: RefusedPack['reason'],
    detail: string,
    extra: { packId?: string; version?: number | null; issues?: readonly PackIssue[] } = {},
  ) =>
    err({
      packId: extra.packId ?? fallbackId,
      version: extra.version ?? null,
      reason,
      detail,
      issues: extra.issues ?? [{ path: '', message: detail }],
    });

  if (bytes.byteLength > SITE_PACK_MAX_BYTES) {
    return refuse(
      'too_large',
      `${bytes.byteLength} bytes; a pack is at most ${SITE_PACK_MAX_BYTES}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return refuse('invalid', 'not UTF-8 JSON');
  }
  const head = headOf(raw);
  const ids = { packId: head.id ?? fallbackId, version: head.version };
  const unknown = head.strategies.filter((id) => !KNOWN_STRATEGIES.has(id));
  if (unknown.length > 0) {
    return refuse(
      'unknown_strategy',
      `unknown strategy ${unknown.map((s) => `'${s}'`).join(', ')}`,
      ids,
    );
  }
  const parsed = SitePackV1.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    return refuse('invalid', issuesText(issues), { ...ids, issues });
  }
  const pack = parsed.data;
  const idsParsed = { packId: pack.id, version: pack.version };
  if (options.expectedId !== null && options.expectedId !== pack.id) {
    return refuse(
      'id_mismatch',
      `the file is named for '${options.expectedId}' but holds '${pack.id}'`,
      idsParsed,
    );
  }
  const refined = refinePack(pack);
  if (refined.issues.length > 0) {
    return refuse('invalid', issuesText(refined.issues), { ...idsParsed, issues: refined.issues });
  }
  if (options.binaryVersion !== null) {
    const v = options.binaryVersion;
    if (
      compareSemver(v, pack.min_client) < 0 ||
      (pack.max_client !== undefined && compareSemver(v, pack.max_client) > 0)
    ) {
      const range =
        pack.max_client === undefined
          ? `${pack.min_client} or later`
          : `${pack.min_client} to ${pack.max_client}`;
      return refuse('min_client', `needs BrowserHive ${range}`, idsParsed);
    }
  }
  return ok({
    pack,
    sha256: sha256Hex(bytes),
    size: bytes.byteLength,
    bytes,
    origin: options.origin,
    warnings: refined.warnings,
  });
}

/** `path: message; …` for messages and logs. */
export function issuesText(issues: readonly PackIssue[]): string {
  return issues.map((i) => (i.path === '' ? i.message : `${i.path}: ${i.message}`)).join('; ');
}

/** The id, version and strategy ids, read leniently before the schema so a skip can name them. */
const Head = z.looseObject({
  id: z.string().optional().catch(undefined),
  version: z.number().int().optional().catch(undefined),
  strategies: z
    .array(z.looseObject({ id: z.string().optional().catch(undefined) }).catch({}))
    .optional()
    .catch(undefined),
});

function headOf(raw: unknown): { id: string | null; version: number | null; strategies: string[] } {
  const head = Head.safeParse(raw);
  if (!head.success) return { id: null, version: null, strategies: [] };
  const strategies = (head.data.strategies ?? []).flatMap((s) =>
    s.id === undefined ? [] : [s.id],
  );
  return { id: head.data.id ?? null, version: head.data.version ?? null, strategies };
}
