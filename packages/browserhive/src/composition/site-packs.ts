/** @module composition/site-packs — the site-pack registry (spec 13 §9.6, §10.5, §10.9): the bundled snapshot (`dist/site-packs` next to the bundled package, else `registry/packs` when running from source), the local folder (`sitePacksDir`, default `<dataDir>/site-packs/local`) and the approved-copy cache (`<dataDir>/site-packs/cache`, D-67). Loaded once at boot; `POST /site-packs/reload` reloads. */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '@browserhive/contracts/config';
import type { Repositories, UnitOfWork } from '@browserhive/core/ports/persistence/index';
import type { DomainEvents, EventBus } from '@browserhive/core/runtime';
import {
  type Clock,
  type IdGenerator,
  type Logger,
  serializeError,
} from '@browserhive/core/runtime';
import {
  BundledPackSource,
  createLocalPackWriter,
  createSitePackCache,
  LocalPackSource,
  SitePackRegistry,
} from '@browserhive/core/server';

/** How far up from this module the search for the bundled packs walks. */
const MAX_DEPTH = 6;

/**
 * The bundled packs: `<…>/site-packs` holding `index.json` (a build: `dist/site-packs`), else the
 * repository's `registry/packs` (a source run). `undefined` when neither exists (no bundled packs).
 */
export function resolveBundledPacksDir(
  fromUrl: string = import.meta.url,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    const built = join(dir, 'site-packs');
    if (exists(join(built, 'index.json'))) return built;
    const source = join(dir, 'registry', 'packs');
    if (exists(source)) return source;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** `<dataDir>/site-packs`. */
export function sitePacksRootOf(dataDir: string): string {
  return join(dataDir, 'site-packs');
}

/** The local folder: `sitePacksDir`, else `<dataDir>/site-packs/local`. */
export function localPacksDirOf(config: Pick<ServerConfig, 'dataDir' | 'sitePacksDir'>): string {
  return config.sitePacksDir ?? join(sitePacksRootOf(config.dataDir), 'local');
}

/** Inputs of {@link buildSitePacks}. */
export interface SitePacksInput {
  readonly config: Readonly<ServerConfig>;
  /** This release (`VERSION`). */
  readonly release: string;
  readonly uow: UnitOfWork;
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly logger: Logger;
  readonly bus: EventBus<DomainEvents>;
  /** Overrides the bundled folder (tests). */
  readonly bundledDir?: string;
}

/** Builds and loads the registry. A failed load never stops the server (nothing applies then). */
export async function buildSitePacks(input: SitePacksInput): Promise<SitePackRegistry> {
  const { config } = input;
  const bundledDir =
    input.bundledDir ??
    resolveBundledPacksDir() ??
    join(sitePacksRootOf(config.dataDir), 'no-bundled-packs');
  const localDir = localPacksDirOf(config);
  const registry = new SitePackRegistry({
    enabled: config.sitePacks,
    bundled: new BundledPackSource({ dir: bundledDir, release: input.release }),
    local: new LocalPackSource({ dir: localDir, binaryVersion: input.release }),
    cache: createSitePackCache(join(sitePacksRootOf(config.dataDir), 'cache')),
    localWriter: createLocalPackWriter(localDir),
    uow: input.uow,
    repos: input.repos,
    binaryVersion: input.release,
    ids: input.ids,
    clock: input.clock,
    logger: input.logger,
    bus: input.bus,
  });
  try {
    await registry.reload();
  } catch (err) {
    input.logger.warn('site packs not loaded', { err: serializeError(err) });
  }
  return registry;
}
