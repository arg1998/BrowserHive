/** @module test/helpers/fake-transport — drives the real McpServer + ToolDispatcher in-process through the SDK's InMemoryTransport and Client, over a real SessionService on FakeBrowserDriver. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolPackId } from '@browserhive/contracts/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Tracer } from '@opentelemetry/api';
import { AttentionService } from '../../src/app/attention/attention-service.ts';
import { AuthStateStore } from '../../src/app/auth-states/store.ts';
import { BlocklistService } from '../../src/app/blocklist/blocklist-service.ts';
import type { DomainEvents, ToolObservation } from '../../src/app/events/catalog.ts';
import { SessionService } from '../../src/app/sessions/session-service.ts';
import { VaultService } from '../../src/app/vault/vault-service.ts';
import { LOCAL_PRINCIPAL, type RequestPrincipal } from '../../src/domain/auth/principal.ts';
import { OperatorRequestBroker } from '../../src/domain/operator-requests/broker.ts';
import { VaultBroker } from '../../src/domain/vault/broker.ts';
import { VaultRedaction } from '../../src/domain/vault/redaction.ts';
import { createPlaywrightPageActions } from '../../src/infra/browsers/page-actions.ts';
import { OffVaultBackend } from '../../src/infra/vault-backends/off.ts';
import type { RuntimeFacts } from '../../src/interface/mcp/context.ts';
import { ToolDispatcher } from '../../src/interface/mcp/dispatcher.ts';
import { authInfoFor } from '../../src/interface/mcp/principal.ts';
import { createToolRegistry } from '../../src/interface/mcp/registry.ts';
import { createMcpServer } from '../../src/interface/mcp/server.ts';
import type { ToolServices } from '../../src/interface/mcp/services.ts';
import { createNodeToolFs } from '../../src/interface/mcp/tool-fs.ts';
import { createRedactor, SecretRegistry } from '../../src/kernel/redact.ts';
import type { BrowserDriver } from '../../src/ports/browser-driver.ts';
import type { PageActions } from '../../src/ports/page-actions.ts';
import { FakeBrowserDriver } from './fake-browser-driver.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeIdGenerator } from './fake-id-generator.ts';
import { FakeVaultBackend } from './fake-vault-backend.ts';
import { createVaultRepos } from './in-memory-vault-repos.ts';
import { RecordingEventBus } from './recording-event-bus.ts';
import { type CollectingLogger, createCollectingLogger } from './test-logger.ts';
import { extendHandle, type ToolFakeScript, toolFakeScript } from './tool-fakes.ts';

/** Options of {@link createToolHarness}. */
export interface ToolHarnessOptions {
  readonly transport?: 'http' | 'stdio';
  readonly allowEvaluate?: boolean;
  readonly vault?: boolean;
  readonly minAttentionWaitMs?: number;
  readonly disabledPacks?: readonly ToolPackId[];
  readonly blocklist?: string;
  readonly defaultChannel?: RuntimeFacts['launchDefaults']['channel'];
  readonly defaultHeadless?: boolean;
  /** Playwright tracing per session (observability suite). */
  readonly trace?: boolean;
  /** Session cap (default 8). */
  readonly maxSessions?: number;
  /** Real driver for integration suites (default: `FakeBrowserDriver`). */
  readonly driver?: BrowserDriver;
  readonly pageActions?: PageActions;
  readonly tracer?: Tracer;
  /** Use the system clock (integration); default a `FakeClock`. */
  readonly clock?:
    | FakeClock
    | { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
  readonly ids?: FakeIdGenerator | ToolServices['ids'];
}

/** A connected in-process MCP client over the real server + dispatcher. */
export interface ToolHarness {
  readonly dataDir: string;
  readonly services: ToolServices;
  readonly dispatcher: ToolDispatcher;
  readonly bus: RecordingEventBus<DomainEvents>;
  readonly driver: BrowserDriver;
  readonly fakeDriver: FakeBrowserDriver | null;
  readonly script: ToolFakeScript;
  readonly logger: CollectingLogger;
  readonly secrets: SecretRegistry;
  readonly vaultBackend: FakeVaultBackend | null;
  readonly attentionBroker: OperatorRequestBroker;
  readonly client: Client;
  /** A second client authenticated as `principal`. */
  connect(principal: RequestPrincipal): Promise<Client>;
  /** `tools/call` on the default (or given) client. */
  call(name: string, args?: Record<string, unknown>, client?: Client): Promise<CallToolResult>;
  /** Parsed JSON of the first text block; throws with the text when `isError`. */
  callJson<T = unknown>(name: string, args?: Record<string, unknown>, client?: Client): Promise<T>;
  /** `launch_session` → session id. */
  launch(args?: Record<string, unknown>, client?: Client): Promise<string>;
  /** Every `tool.called` observation so far. */
  observations(): ToolObservation[];
  close(): Promise<void>;
}

/** The first text block of a result. */
export function textOf(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === 'text');
  return block !== undefined && block.type === 'text' ? block.text : '';
}

/** Builds the harness (temp data dir, real services, fake browser unless a driver is given). */
export async function createToolHarness(options: ToolHarnessOptions = {}): Promise<ToolHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'bh-mcp-'));
  await mkdir(join(dataDir, 'uploads'), { recursive: true });
  const clock = options.clock ?? new FakeClock();
  const ids = options.ids ?? new FakeIdGenerator();
  const logger = createCollectingLogger({ level: 'trace' });
  const bus = new RecordingEventBus<DomainEvents>();
  const script = toolFakeScript();
  const fakeDriver = options.driver === undefined ? new FakeBrowserDriver() : null;
  fakeDriver?.onLaunch((handle) => extendHandle(handle, script));
  const driver: BrowserDriver = options.driver ?? fakeDriver ?? new FakeBrowserDriver();
  const authStates = new AuthStateStore({ dataDir, clock, logger });
  const sessions = new SessionService({
    clock,
    ids,
    logger,
    bus,
    driver,
    proxyResolver: { resolve: async () => null },
    authStates,
    config: {
      dataDir,
      sessionLease: 7_200_000,
      sessionCloseTimeout: 10_000,
      defaultHeadless: options.defaultHeadless ?? true,
      defaultChannel: options.defaultChannel ?? 'chromium',
      persistence: 'memory',
      maxSessions: options.maxSessions ?? 8,
      stealth: 'off',
      stealthDriver: 'playwright',
      fingerprint: false,
      humanize: false,
      trace: options.trace ?? false,
      screenshotTrace: false,
    },
  });
  const transport = options.transport ?? 'http';
  const repos = createVaultRepos();
  const attentionBroker = new OperatorRequestBroker({
    requests: repos.requests,
    actions: repos.actions,
    leases: sessions.lease,
    events: bus,
    clock,
    ids,
    logger,
  });
  const secrets = new SecretRegistry({ now: () => clock.now() });
  const redaction = new VaultRedaction({ registry: secrets, now: () => clock.now() });
  const vaultBackend = options.vault === true ? new FakeVaultBackend() : null;
  const vaultBroker =
    vaultBackend === null
      ? null
      : new VaultBroker({
          backend: vaultBackend,
          bindings: repos.bindings,
          policies: repos.policies,
          audit: repos.audit,
          redaction,
          events: bus,
          clock,
          ids,
          logger,
          allowEvaluate: options.allowEvaluate ?? true,
          confirm: attentionBroker,
        });
  const vault = new VaultService({
    backend: vaultBackend ?? new OffVaultBackend(),
    broker: vaultBroker,
    bindings: repos.bindings,
    policies: repos.policies,
    audit: repos.audit,
    confirm: attentionBroker,
    clock,
    logger,
  });
  let blocklistPath: string | undefined;
  if (options.blocklist !== undefined) {
    blocklistPath = join(dataDir, 'blocklist.txt');
    await writeFile(blocklistPath, options.blocklist);
  }
  const blocklist = new BlocklistService({
    path: blocklistPath,
    fs: { readFile: (p) => Bun.file(p).text() },
    bus,
    clock,
    ids,
    logger,
  });
  await blocklist.load();
  const redactor = createRedactor(secrets);
  const runtime: RuntimeFacts = {
    version: '0.1.0',
    transport,
    startedAt: clock.now(),
    allowEvaluate: options.allowEvaluate ?? true,
    minAttentionWaitMs: options.minAttentionWaitMs ?? 0,
    vault: { enabled: vaultBackend !== null, backend: vaultBackend === null ? null : 'bitwarden' },
    dataDir,
    persistenceMode: 'memory',
    launchDefaults: {
      channel: options.defaultChannel ?? 'chromium',
      headless: options.defaultHeadless ?? true,
    },
  };
  const services: ToolServices = {
    sessions,
    attention:
      transport === 'http'
        ? new AttentionService({
            broker: attentionBroker,
            clock,
            logger,
            config: { transport, attentionTimeoutMs: 21_600_000, minAttentionWaitMs: 0 },
          })
        : null,
    vault,
    authStates,
    blocklist,
    pageActions: options.pageActions ?? createPlaywrightPageActions(),
    fs: createNodeToolFs(),
    redaction: {
      scrubText: (sessionId, text) =>
        redactor.scrubText(sessionId === null ? text : redaction.scrub(sessionId, text)),
      onNavigation: (sessionId, url) => redaction.onNavigation(sessionId, url),
    },
    bus,
    clock,
    ids,
    runtime,
  };
  const registry = createToolRegistry(runtime, {
    ...(options.disabledPacks !== undefined && { disabledPacks: options.disabledPacks }),
  });
  const dispatcher = new ToolDispatcher({
    services,
    registry,
    logger,
    ...(options.tracer !== undefined && { tracer: options.tracer }),
  });

  const clients: Client[] = [];
  const connect = async (principal: RequestPrincipal): Promise<Client> => {
    const server = createMcpServer({ runtime, dispatcher, connectionIdOf: () => null });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = clientSide.send.bind(clientSide);
    // The SDK client never attaches authInfo; the harness plays the authenticated HTTP edge.
    clientSide.send = (message, sendOptions) =>
      send(message, { ...sendOptions, authInfo: authInfoFor(principal) });
    await server.connect(serverSide);
    const client = new Client({ name: 'harness', version: '1.0.0' });
    await client.connect(clientSide);
    await client.listTools();
    clients.push(client);
    return client;
  };
  const client = await connect(LOCAL_PRINCIPAL);

  const call = async (name: string, args: Record<string, unknown> = {}, via = client) => {
    const result = await via.callTool({ name, arguments: args });
    return result as CallToolResult;
  };
  const callJson = async <T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    via = client,
  ) => {
    const result = await call(name, args, via);
    const text = textOf(result);
    if (result.isError === true) throw new Error(text);
    return JSON.parse(text) as T;
  };
  return {
    dataDir,
    services,
    dispatcher,
    bus,
    driver,
    fakeDriver,
    script,
    logger,
    secrets,
    vaultBackend,
    attentionBroker,
    client,
    connect,
    call,
    callJson,
    launch: async (args = {}, via = client) =>
      (await callJson<{ session_id: string }>('launch_session', { slug: 'demo', ...args }, via))
        .session_id,
    observations: () =>
      bus.published
        .filter((p) => p.name === 'tool.called')
        .map((p) => (p.payload as DomainEvents['tool.called']).observation),
    close: async () => {
      await sessions.closeAll('shutdown', 10_000);
      await attentionBroker.shutdown();
      for (const c of clients) await c.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
