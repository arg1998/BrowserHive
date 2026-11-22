/** @module composition/site-pack-client — the site-pack registry client (spec 13 §10.3–§10.6, §10.9, D-55): the hygienic fetcher of `sitePacksUrl` (or the testing seam's loopback fake registry), the verifier over the trust root (pinned, or the seam's test root), the held layout in `<dataDir>/site-packs/remote/`, the release snapshot in `<bundled>/registry/v1/`, and the automatic check's timer. Started once the registry is loaded; stopped with the server. */

import { lstat, open } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import type { Repositories } from '@browserhive/core/ports/persistence/index';
import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import type {
  Clock,
  DegradationReporter,
  DomainEvents,
  EventBus,
  IdGenerator,
  Logger,
} from '@browserhive/core/runtime';
import {
  createHeldLayoutStore,
  createRegistryFetcher,
  createRegistryVerifier,
  type SitePackRegistry,
  SitePackRegistryClient,
  sha256Hex,
} from '@browserhive/core/server';
import { sitePacksRootOf } from './site-packs.ts';

/** The testing seam's registry (spec 13 §10.2): a loopback `http:` URL and the check's timing. */
export interface SitePackClientTesting {
  readonly url?: string;
  readonly firstCheckMs?: number;
  readonly intervalMs?: number;
}

/** Inputs of {@link buildSitePackClient}. */
export interface SitePackClientInput {
  readonly config: Readonly<ServerConfig>;
  readonly registry: SitePackRegistry;
  readonly release: string;
  readonly trustRoot: SitePacksTrustRoot;
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly logger: Logger;
  readonly bus: EventBus<DomainEvents>;
  readonly degradations?: DegradationReporter;
  /** The bundled packs' folder; a build's `dist/site-packs` holds the snapshot in `registry/v1/`. */
  readonly bundledDir?: string | undefined;
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly testing?: SitePackClientTesting | undefined;
}

/** `<dataDir>/site-packs/remote`: the held signed layout. */
export function heldLayoutDirOf(dataDir: string): string {
  return join(sitePacksRootOf(dataDir), 'remote');
}

/** The release snapshot's folder next to the bundled packs (`dist/site-packs/registry/v1`). */
export function snapshotDirOf(bundledDir: string): string {
  return join(bundledDir, 'registry', 'v1');
}

/** Reads `path` under `dir` (never outside it), at most `max` bytes; `null` when absent or larger. */
async function readUnder(dir: string, path: string, max: number): Promise<Uint8Array | null> {
  const root = resolve(dir);
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`)) return null;
  // A regular file only: a FIFO would block the boot, a symlink could point anywhere (review #100 I3).
  const info = await lstat(target).catch(() => null);
  if (info === null || !info.isFile()) return null;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, 'r');
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    if (size > max) return null;
    const buffer = new Uint8Array(size);
    let total = 0;
    while (total < size) {
      const { bytesRead } = await handle.read(buffer, total, size - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.slice(0, total);
  } finally {
    await handle.close();
  }
}

/** Builds and starts the client; returns it with its stop. */
export async function buildSitePackClient(
  input: SitePackClientInput,
): Promise<SitePackRegistryClient> {
  const { config } = input;
  const testingUrl = input.testing?.url;
  const client = new SitePackRegistryClient({
    registry: input.registry,
    packsEnabled: config.templates && config.sitePacks,
    updateCheck: config.sitePacksUpdateCheck,
    autoUpdate: config.sitePacksAutoUpdate,
    fetcher: createRegistryFetcher({
      url: testingUrl ?? config.sitePacksUrl,
      allowLoopbackHttp: testingUrl !== undefined,
    }),
    verifier: createRegistryVerifier(input.trustRoot),
    held: createHeldLayoutStore(heldLayoutDirOf(config.dataDir)),
    meta: input.repos.sitePackMeta,
    repos: input.repos,
    ...(input.bundledDir !== undefined && {
      snapshot: createHeldLayoutStore(snapshotDirOf(input.bundledDir)),
    }),
    readFolder: readUnder,
    binaryVersion: input.release,
    sha256: sha256Hex,
    ids: input.ids,
    clock: input.clock,
    logger: input.logger,
    bus: input.bus,
    ...(input.degradations !== undefined && { degradations: input.degradations }),
    ...(input.testing?.firstCheckMs !== undefined && { firstCheckMs: input.testing.firstCheckMs }),
    ...(input.testing?.intervalMs !== undefined && { intervalMs: input.testing.intervalMs }),
    schedule: input.schedule,
  });
  await client.start();
  return client;
}
