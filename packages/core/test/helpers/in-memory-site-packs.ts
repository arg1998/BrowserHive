/** @module test/helpers/in-memory-site-packs — the registry's file ports in memory: a pack source over a map of `<id>.json` bytes (checked with `loadPackBytes` like the real sources), the approved-copy cache, and the import writer into an in-memory local source. */

import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { SitePackRegistry } from '../../src/app/site-packs/registry.ts';
import { loadPackBytes } from '../../src/domain/site-packs/load.ts';
import { ok, type Result } from '../../src/kernel/result.ts';
import type { Clock } from '../../src/ports/clock.ts';
import type { EventPublisher } from '../../src/ports/event-bus.ts';
import type { IdGenerator } from '../../src/ports/id-generator.ts';
import type { Logger } from '../../src/ports/logger.ts';
import type { Repositories } from '../../src/ports/persistence/index.ts';
import type { SitePackSourceId } from '../../src/ports/persistence/site-packs.ts';
import type { LocalPackWriter, SitePackCache } from '../../src/ports/site-pack-files.ts';
import type {
  SitePackSource,
  SitePackSourceError,
  SkippedPackVersion,
  SourceCatalog,
  SourcePackVersion,
} from '../../src/ports/site-packs.ts';
import { InMemoryUnitOfWork } from './in-memory-repos.ts';
import { packBytes, sitePack } from './site-pack-kit.ts';

/** The release the in-memory sources report. */
export const MEMORY_RELEASE = '0.3.0';

/** A source over `files` (`<id>` → bytes). */
export class InMemoryPackSource implements SitePackSource {
  readonly trust: 'publisher' | 'operator';
  readonly files = new Map<string, Uint8Array>();
  readonly builtAt = null;

  constructor(
    readonly id: 'bundled' | 'local',
    readonly release: string,
    readonly dir = `/mem/${id}`,
  ) {
    this.trust = id === 'local' ? 'operator' : 'publisher';
  }

  /** Puts a pack (canonical bytes). */
  put(pack: SitePackV1Input): void {
    this.files.set(pack.id, packBytes(pack));
  }

  load(_signal: AbortSignal): Promise<Result<SourceCatalog, SitePackSourceError>> {
    const packs: SourcePackVersion[] = [];
    const skipped: SkippedPackVersion[] = [];
    for (const [id, bytes] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const loaded = loadPackBytes(bytes, {
        origin: this.id === 'local' ? `${this.dir}/${id}.json` : this.release,
        binaryVersion: this.release,
        expectedId: id,
      });
      if (loaded.ok) packs.push(loaded.value);
      else skipped.push(loaded.error);
    }
    return Promise.resolve(ok({ source: this.id, packs, skipped, signedLayouts: 0 }));
  }
}

/** The approved-copy cache in memory. */
export class InMemoryPackCache implements SitePackCache {
  readonly copies = new Map<string, Uint8Array>();

  pathOf(source: SitePackSourceId, packId: string, sha256: string): string {
    return `/mem/cache/${source}/${packId}/${sha256}.json`;
  }

  put(source: SitePackSourceId, packId: string, sha256: string, bytes: Uint8Array): Promise<void> {
    this.copies.set(this.pathOf(source, packId, sha256), bytes);
    return Promise.resolve();
  }

  get(source: SitePackSourceId, packId: string, sha256: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.copies.get(this.pathOf(source, packId, sha256)) ?? null);
  }
}

/** The import writer into an in-memory local source. */
export function inMemoryLocalWriter(local: InMemoryPackSource): LocalPackWriter {
  return {
    dir: local.dir,
    write(packId, bytes) {
      local.files.set(packId, bytes);
      return Promise.resolve(`${local.dir}/${packId}.json`);
    },
  };
}

/** The registry of the HTTP kit: bundled `site-a.test` v1, nothing local; in memory. */
export async function createMemorySitePacks(deps: {
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly logger: Logger;
  readonly bus?: EventPublisher<DomainEvents>;
}): Promise<{
  readonly registry: SitePackRegistry;
  readonly bundled: InMemoryPackSource;
  readonly local: InMemoryPackSource;
}> {
  const bundled = new InMemoryPackSource('bundled', MEMORY_RELEASE);
  const local = new InMemoryPackSource('local', MEMORY_RELEASE);
  bundled.put(sitePack('site-a.test', 1));
  const registry = new SitePackRegistry({
    enabled: true,
    bundled,
    local,
    cache: new InMemoryPackCache(),
    localWriter: inMemoryLocalWriter(local),
    uow: new InMemoryUnitOfWork(deps.repos),
    repos: deps.repos,
    binaryVersion: MEMORY_RELEASE,
    ids: deps.ids,
    clock: deps.clock,
    logger: deps.logger,
    ...(deps.bus !== undefined && { bus: deps.bus }),
  });
  await registry.reload();
  return { registry, bundled, local };
}
