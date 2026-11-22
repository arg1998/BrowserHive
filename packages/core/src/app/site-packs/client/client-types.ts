/** @module app/site-packs/client/client-types — the registry client's collaborators and its in-memory view of the held layout (spec 13 §10.3–§10.6). */

import type { RegistryIndexV1, RegistryKeysV1 } from '@browserhive/contracts/site-packs';
import type { Clock } from '../../../ports/clock.ts';
import type { DegradationReporter } from '../../../ports/degradation-reporter.ts';
import type { EventPublisher } from '../../../ports/event-bus.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { Repositories } from '../../../ports/persistence/index.ts';
import type { SitePackMetaRepository } from '../../../ports/persistence/site-packs.ts';
import type {
  HeldLayoutStore,
  RegistryFetcher,
  RegistryVerifier,
} from '../../../ports/site-pack-registry.ts';
import type { DomainEvents } from '../../events/catalog.ts';
import type { SitePackRegistry } from '../registry.ts';
import type { LayoutFiles } from './accept.ts';

/** Reads the files of a folder for an import of the local folder: `null` for a missing file. */
export type FolderReader = (
  dir: string,
  path: string,
  maxBytes: number,
) => Promise<Uint8Array | null>;

/** Collaborators of `SitePackRegistryClient`. */
export interface RegistryClientDeps {
  readonly registry: SitePackRegistry;
  /** `sitePacks` (spec 13 §9.6): `false` turns the client off with the rest of the layer. */
  readonly packsEnabled: boolean;
  /** `sitePacksUpdateCheck`: `false` makes no request at all (§10.5). */
  readonly updateCheck: boolean;
  /** `sitePacksAutoUpdate`. */
  readonly autoUpdate: boolean;
  readonly fetcher: RegistryFetcher;
  readonly verifier: RegistryVerifier;
  readonly held: HeldLayoutStore;
  readonly meta: SitePackMetaRepository;
  /** `operator_actions` for `site_pack.check`, `site_pack.download`, `site_pack.import`. */
  readonly repos: Pick<Repositories, 'operatorActions'>;
  /** The release's signed snapshot (`dist/site-packs/registry/v1/`, §10.9), when it ships one. */
  readonly snapshot?: HeldLayoutStore;
  /** Reads a folder's files (signed layouts in `sitePacksDir`). */
  readonly readFolder?: FolderReader;
  readonly binaryVersion: string;
  readonly sha256: (bytes: Uint8Array) => string;
  readonly ids: { eventId(): string };
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bus?: EventPublisher<DomainEvents>;
  readonly degradations?: DegradationReporter;
  /** Delay of the first automatic check after `start()` (5 min). */
  readonly firstCheckMs?: number;
  /** Base interval of the automatic check (24 h; ± 2 h of jitter is added). */
  readonly intervalMs?: number;
  /** A number in [0, 1) for the jitter (tests). */
  readonly random?: () => number;
  /** One-shot unref'd timer; returns its cancel function. */
  readonly schedule: (fn: () => void, ms: number) => () => void;
}

/** The held layout in memory: the verified files and what they say. */
export interface HeldState {
  readonly files: LayoutFiles;
  readonly keys: RegistryKeysV1;
  readonly index: RegistryIndexV1;
  readonly signedBy: string;
  readonly origin: 'registry' | 'import' | 'local';
  readonly originName: string | null;
}
