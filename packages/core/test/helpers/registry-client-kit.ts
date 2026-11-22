/** @module test/helpers/registry-client-kit — the registry client in tests (spec 13 §10.3–§10.6): a signed registry built at run time with throwaway keys (several versions per pack, revocations, notes), an in-memory fetcher over it that records every request (or a `Bun.serve` fake registry for the real fetcher), an in-memory held layout, and a client wired to an in-memory `SitePackRegistry`. Nothing reaches browserhive.ai. */

import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import type { RegistryClientDeps } from '../../src/app/site-packs/client/client-types.ts';
import { SitePackRegistryClient } from '../../src/app/site-packs/client/registry-client.ts';
import type { SitePackRegistry } from '../../src/app/site-packs/registry.ts';
import { sha256Hex } from '../../src/domain/site-packs/load.ts';
import { createRegistryVerifier } from '../../src/infra/site-packs/registry-verifier.ts';
import type {
  HeldLayoutFile,
  HeldLayoutStore,
  RegistryFetcher,
  RegistryFetchRequest,
  RegistryFetchResult,
} from '../../src/ports/site-pack-registry.ts';
import type { SitePacksTrustRoot } from '../../src/ports/site-packs.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeIdGenerator } from './fake-id-generator.ts';
import { InMemoryRepositories } from './in-memory-repos.ts';
import { createMemorySitePacks, type InMemoryPackSource } from './in-memory-site-packs.ts';
import { InMemoryOperatorActionRepository } from './in-memory-vault-repos.ts';
import { RecordingEventBus } from './recording-event-bus.ts';
import { canonical, iso, rootOf, sigOf, type TestKey, testKey } from './registry-kit.ts';
import { packBytes } from './site-pack-kit.ts';
import { RecordingDegradations } from './template-kit.ts';
import { createCollectingLogger } from './test-logger.ts';

const DAY = 86_400_000;

/** One listed version of a test registry. */
export interface ListedVersion {
  readonly pack: SitePackV1Input;
  readonly revoked?: boolean;
  readonly notes?: string;
  readonly released?: string;
  /** Overrides of the index entry (a wrong size, another hash…). */
  readonly entry?: Record<string, unknown>;
  /** Serve other bytes at its path (a swapped file). */
  readonly served?: Uint8Array;
}

/** Options of {@link signRegistry}. */
export interface RegistryOptions {
  readonly now: number;
  readonly versions: readonly ListedVersion[];
  readonly root?: TestKey;
  readonly online?: TestKey;
  readonly keysVersion?: number;
  readonly indexVersion?: number;
  readonly keys?: Record<string, unknown>;
  readonly index?: Record<string, unknown>;
  /** Sign `index.json` with this key instead of the online key. */
  readonly indexSigner?: TestKey;
}

/** A signed test registry: its files by path, keys and the trust root that accepts it. */
export interface TestRegistry {
  readonly files: Map<string, Uint8Array>;
  readonly root: TestKey;
  readonly online: TestKey;
  readonly trustRoot: SitePacksTrustRoot;
}

/** Builds a signed registry layout (versions grouped per pack, newest first). */
export function signRegistry(options: RegistryOptions): TestRegistry {
  const root = options.root ?? testKey();
  const online = options.online ?? testKey();
  const files = new Map<string, Uint8Array>();
  const byPack = new Map<string, { title: string; versions: Record<string, unknown>[] }>();
  for (const listed of options.versions) {
    const bytes = packBytes(listed.pack);
    const sha256 = sha256Hex(bytes);
    const path = `packs/${listed.pack.id}/${sha256}.json`;
    files.set(path, listed.served ?? bytes);
    const group = byPack.get(listed.pack.id) ?? { title: listed.pack.title, versions: [] };
    group.versions.push({
      v: listed.pack.version,
      min_client: listed.pack.min_client,
      ...(listed.pack.max_client !== undefined && { max_client: listed.pack.max_client }),
      sha256,
      size: bytes.byteLength,
      path,
      released: listed.released ?? '2026-11-20',
      notes: listed.notes ?? `Version ${listed.pack.version}.`,
      ...(listed.revoked === true && { revoked: true }),
      ...listed.entry,
    });
    byPack.set(listed.pack.id, group);
  }
  const packs = [...byPack].map(([id, g]) => ({
    id,
    title: g.title,
    versions: g.versions.sort((a, b) => Number(b['v']) - Number(a['v'])),
  }));
  const keysDoc = {
    schema: 1,
    version: options.keysVersion ?? 1,
    expires: iso(options.now + 60 * DAY),
    online: [
      {
        key_id: online.keyId,
        public_key: online.publicKey,
        not_after: iso(options.now + 30 * DAY),
      },
    ],
    ...options.keys,
  };
  const indexDoc = {
    schema: 1,
    version: options.indexVersion ?? 10,
    issued_at: iso(options.now - 60_000),
    expires: iso(options.now + 7 * DAY),
    packs,
    ...options.index,
  };
  const keys = canonical(keysDoc);
  const index = canonical(indexDoc);
  files.set('keys.json', keys);
  files.set('keys.json.sig', sigOf(keys, root));
  files.set('index.json', index);
  files.set('index.json.sig', sigOf(index, options.indexSigner ?? online));
  return { files, root, online, trustRoot: rootOf(root) };
}

/** One request a fake registry saw. */
export interface SeenRequest {
  readonly path: string;
  readonly ifNoneMatch: string | null;
}

/**
 * A fetcher over `files` answering like browserhive.ai (200 always) or, with `shaEtags`, like a
 * host whose ETag is the body's SHA-256 (`304` when `If-None-Match` matches). `fail` makes every
 * request fail; `requests` records each one.
 */
export class MemoryFetcher implements RegistryFetcher {
  readonly url = 'https://registry.test/registry/v1/';
  readonly requests: SeenRequest[] = [];
  files: Map<string, Uint8Array>;
  shaEtags = false;
  fail: RegistryFetchResult | null = null;
  date: number | null = null;

  constructor(files: Map<string, Uint8Array>) {
    this.files = files;
  }

  async fetch(request: RegistryFetchRequest): Promise<RegistryFetchResult> {
    this.requests.push({
      path: request.path,
      ifNoneMatch: request.heldSha256 === undefined ? null : `"${request.heldSha256}"`,
    });
    if (this.fail !== null) return this.fail;
    const bytes = this.files.get(request.path);
    if (bytes === undefined) {
      return {
        kind: 'failed',
        reason: 'http_status',
        status: 404,
        detail: 'HTTP 404',
        date: this.date,
      };
    }
    if (this.shaEtags && request.heldSha256 === sha256Hex(bytes)) {
      return { kind: 'not_modified', date: this.date };
    }
    if (bytes.byteLength > request.maxBytes) {
      return {
        kind: 'failed',
        reason: 'too_large',
        status: 200,
        detail: 'too large',
        date: this.date,
      };
    }
    return { kind: 'ok', bytes, date: this.date };
  }
}

/** A held layout store in memory. */
export class MemoryHeldStore implements HeldLayoutStore {
  readonly dir = '/mem/site-packs/remote';
  readonly files = new Map<HeldLayoutFile, Uint8Array>();

  async read(file: HeldLayoutFile): Promise<Uint8Array | null> {
    return this.files.get(file) ?? null;
  }

  async write(files: Partial<Readonly<Record<HeldLayoutFile, Uint8Array>>>): Promise<void> {
    for (const [name, bytes] of Object.entries(files)) {
      if (bytes !== undefined) this.files.set(name as HeldLayoutFile, bytes);
    }
  }
}

/** The in-memory repositories with operator actions (audit rows). */
export type KitRepos = InMemoryRepositories & {
  readonly operatorActions: InMemoryOperatorActionRepository;
};

/** Fresh repositories for {@link createClientKit} (share them across a "restart"). */
export function kitRepos(): KitRepos {
  const base = new InMemoryRepositories();
  return Object.assign(base, {
    operatorActions: new InMemoryOperatorActionRepository(),
  }) as KitRepos;
}

/** Options of {@link createClientKit}. */
export interface ClientKitOptions {
  readonly registry?: TestRegistry;
  readonly trustRoot?: SitePacksTrustRoot;
  readonly clock?: FakeClock;
  readonly updateCheck?: boolean;
  readonly autoUpdate?: boolean;
  readonly packsEnabled?: boolean;
  readonly fetcher?: RegistryFetcher;
  /** The bundled packs (default: `pack-a.test` v1). */
  readonly bundled?: readonly SitePackV1Input[];
  readonly snapshot?: HeldLayoutStore;
  readonly readFolder?: RegistryClientDeps['readFolder'];
  /** Shares a database and held layout across restarts. */
  readonly repos?: KitRepos;
  readonly held?: MemoryHeldStore;
}

/** A client, its registry and every fake around it. */
export interface ClientKit {
  readonly client: SitePackRegistryClient;
  readonly registry: SitePackRegistry;
  readonly bundled: InMemoryPackSource;
  readonly local: InMemoryPackSource;
  readonly fetcher: RegistryFetcher;
  readonly held: MemoryHeldStore;
  readonly repos: KitRepos;
  readonly clock: FakeClock;
  readonly bus: RecordingEventBus<DomainEvents>;
  readonly degradations: RecordingDegradations;
  /** Scheduled automatic checks: `{ ms, fn }`, newest last. */
  readonly timers: { ms: number; fn: () => void; cancelled: boolean }[];
}

/** A client over an in-memory registry; `start()` has run. */
export async function createClientKit(options: ClientKitOptions = {}): Promise<ClientKit> {
  const clock = options.clock ?? new FakeClock(Date.UTC(2026, 10, 22, 10));
  const repos = options.repos ?? kitRepos();
  const bus = new RecordingEventBus<DomainEvents>();
  const degradations = new RecordingDegradations();
  const logger = createCollectingLogger();
  const ids = new FakeIdGenerator();
  const memory = await createMemorySitePacks({ repos, clock, ids, logger, bus, degradations });
  if (options.bundled !== undefined) {
    memory.bundled.files.clear();
    for (const pack of options.bundled) memory.bundled.put(pack);
    await memory.registry.reload();
  }
  const fetcher = options.fetcher ?? new MemoryFetcher(options.registry?.files ?? new Map());
  const held = options.held ?? new MemoryHeldStore();
  const timers: ClientKit['timers'] = [];
  const trustRoot = options.trustRoot ?? options.registry?.trustRoot ?? { keys: [] };
  const client = new SitePackRegistryClient({
    registry: memory.registry,
    packsEnabled: options.packsEnabled ?? true,
    updateCheck: options.updateCheck ?? true,
    autoUpdate: options.autoUpdate ?? false,
    fetcher,
    verifier: createRegistryVerifier(trustRoot),
    held,
    meta: repos.sitePackMeta,
    repos,
    ...(options.snapshot !== undefined && { snapshot: options.snapshot }),
    ...(options.readFolder !== undefined && { readFolder: options.readFolder }),
    binaryVersion: '0.3.0',
    sha256: sha256Hex,
    ids,
    clock,
    logger,
    bus,
    degradations,
    random: () => 0.5,
    schedule: (fn, ms) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  await client.start();
  return {
    client,
    registry: memory.registry,
    bundled: memory.bundled,
    local: memory.local,
    fetcher,
    held,
    repos,
    clock,
    bus,
    degradations,
    timers,
  };
}
