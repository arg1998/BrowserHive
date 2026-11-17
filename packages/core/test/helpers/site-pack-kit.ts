/** @module test/helpers/site-pack-kit — a `SitePackRegistry` over temporary bundled, local and cache folders and in-memory repositories, with a small valid pack builder for fixture sites (`site-a.test`). */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { SitePackRegistry } from '../../src/app/site-packs/registry.ts';
import type { SitePackRegistryDeps } from '../../src/app/site-packs/registry-types.ts';
import { sha256Hex } from '../../src/domain/site-packs/load.ts';
import { BundledPackSource } from '../../src/infra/site-packs/bundled-source.ts';
import { LocalPackSource } from '../../src/infra/site-packs/local-source.ts';
import {
  createLocalPackWriter,
  createSitePackCache,
} from '../../src/infra/site-packs/pack-cache.ts';
import type { DegradationReporter } from '../../src/ports/degradation-reporter.ts';
import type { Repositories } from '../../src/ports/persistence/index.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeIdGenerator } from './fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from './in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from './in-memory-vault-repos.ts';
import { RecordingEventBus } from './recording-event-bus.ts';
import { createCollectingLogger } from './test-logger.ts';

/** The release the kit's bundled source reports. */
export const KIT_RELEASE = '0.3.0';

/** A small valid pack for `id` (a registrable domain such as `site-a.test`). */
export function sitePack(id: string, version: number, extra: Partial<SitePackV1Input> = {}) {
  const pack: SitePackV1Input = {
    schema: 1,
    id,
    version,
    min_client: '0.1.0',
    title: `Site ${id}`,
    domains: [id],
    sign_in: { url: { host: `www.${id}`, path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: `www.${id}`, path: '/account' },
      kind: 'redirect',
      signed_out_redirects: [`www.${id}/login*`],
    },
    guards: [{ id: 'logout', kind: 'logout', match: { url: `www.${id}/logout` }, action: 'block' }],
    write_policy: { default: 'confirm', stance: 'prohibited' },
    ...extra,
  };
  return pack;
}

/** The bytes the kit writes for a pack (canonical: two-space JSON and a newline). */
export function packBytes(pack: SitePackV1Input): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(pack, null, 2)}\n`);
}

/** SHA-256 of {@link packBytes}. */
export function packSha(pack: SitePackV1Input): string {
  return sha256Hex(packBytes(pack));
}

/** Writes `<dir>/<id>.json`. */
export function writePack(dir: string, pack: SitePackV1Input): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pack.id}.json`), packBytes(pack));
}

/** The folders of one kit. */
export interface SitePackDirs {
  readonly root: string;
  readonly bundled: string;
  readonly local: string;
  readonly cache: string;
}

/** Fresh temporary folders (remove with {@link removeDirs}). */
export function makeDirs(): SitePackDirs {
  const root = mkdtempSync(join(tmpdir(), 'bh-sp-'));
  return {
    root,
    bundled: join(root, 'bundled'),
    local: join(root, 'local'),
    cache: join(root, 'cache'),
  };
}

/** Removes a kit's folders. */
export function removeDirs(dirs: SitePackDirs): void {
  rmSync(dirs.root, { recursive: true, force: true });
}

/** Options of {@link createSitePackKit}. */
export interface SitePackKitOptions {
  readonly dirs?: SitePackDirs;
  /** Shared across "releases" so a second registry sees the first one's decisions. */
  readonly repos?: InMemoryRepositories;
  readonly actions?: InMemoryOperatorActionRepository;
  /** The bundled folder (default `dirs.bundled`): a second one simulates a newer release. */
  readonly bundledDir?: string;
  readonly enabled?: boolean;
  readonly clock?: FakeClock;
  /** Shared across "releases" so event ids stay unique. */
  readonly ids?: FakeIdGenerator;
  readonly degradations?: DegradationReporter;
}

/** A registry with its collaborators. */
export interface SitePackKit {
  readonly registry: SitePackRegistry;
  readonly repos: InMemoryRepositories;
  readonly actions: InMemoryOperatorActionRepository;
  readonly bus: RecordingEventBus<DomainEvents>;
  readonly clock: FakeClock;
  readonly ids: FakeIdGenerator;
  readonly dirs: SitePackDirs;
  readonly templatesChanged: string[];
}

/** Builds a registry (not yet loaded: call `registry.reload()`). */
export function createSitePackKit(options: SitePackKitOptions = {}): SitePackKit {
  const dirs = options.dirs ?? makeDirs();
  const repos = options.repos ?? new InMemoryRepositories();
  const actions = options.actions ?? new InMemoryOperatorActionRepository();
  const wired: Repositories = { ...repos, operatorActions: actions };
  const bus = new RecordingEventBus<DomainEvents>();
  const clock = options.clock ?? new FakeClock();
  const ids = options.ids ?? new FakeIdGenerator();
  const templatesChanged: string[] = [];
  const registry = new SitePackRegistry({
    enabled: options.enabled ?? true,
    bundled: new BundledPackSource({
      dir: options.bundledDir ?? dirs.bundled,
      release: KIT_RELEASE,
    }),
    local: new LocalPackSource({ dir: dirs.local, binaryVersion: KIT_RELEASE }),
    cache: createSitePackCache(dirs.cache),
    localWriter: createLocalPackWriter(dirs.local),
    uow: new InMemoryUnitOfWork(wired),
    repos: wired,
    binaryVersion: KIT_RELEASE,
    ids,
    clock,
    logger: createCollectingLogger(),
    bus,
    templateChanged: (id) => templatesChanged.push(id),
    ...(options.degradations !== undefined && { degradations: options.degradations }),
  });
  return { registry, repos, actions, bus, clock, ids, dirs, templatesChanged };
}

/** A registry over `dirs` with the given storage (SQLite tests); not yet loaded. */
export function createDirRegistry(
  dirs: SitePackDirs,
  storage: {
    readonly uow: SitePackRegistryDeps['uow'];
    readonly repos: SitePackRegistryDeps['repos'];
    readonly ids: SitePackRegistryDeps['ids'];
    readonly clock: SitePackRegistryDeps['clock'];
  },
): SitePackRegistry {
  return new SitePackRegistry({
    enabled: true,
    bundled: new BundledPackSource({ dir: dirs.bundled, release: KIT_RELEASE }),
    local: new LocalPackSource({ dir: dirs.local, binaryVersion: KIT_RELEASE }),
    cache: createSitePackCache(dirs.cache),
    localWriter: createLocalPackWriter(dirs.local),
    binaryVersion: KIT_RELEASE,
    logger: createCollectingLogger(),
    ...storage,
  });
}
