/** @module test/helpers/http-kit — the real `createHttpApp` over in-memory repositories, real auth/attention/vault/session services and port fakes; no network port. */

import { AttentionService } from '../../src/app/attention/attention-service.ts';
import { createAuthAudit } from '../../src/app/auth/audit.ts';
import { createAuthService } from '../../src/app/auth/auth-service.ts';
import { createAuthenticator } from '../../src/app/auth/authenticate.ts';
import { adminProviderChain, mcpProviderChain } from '../../src/app/auth/providers/index.ts';
import { configView } from '../../src/app/config/provenance-view.ts';
import { resolveOk } from '../../src/app/config/test-support.ts';
import { InProcessEventBus } from '../../src/app/events/bus.ts';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { sessionDirLayout } from '../../src/app/sessions/profile-dir.ts';
import { SessionService } from '../../src/app/sessions/session-service.ts';
import { FakeSessionDirFs, testConfig } from '../../src/app/sessions/test-support.ts';
import { VaultService } from '../../src/app/vault/vault-service.ts';
import { OperatorRequestBroker } from '../../src/domain/operator-requests/broker.ts';
import { createHttpApp, type HttpApp } from '../../src/interface/http/app.ts';
import type { HttpServices } from '../../src/interface/http/services.ts';
import type { StaticAssets } from '../../src/ports/static-assets.ts';
import { CollectingLogger } from './collecting-logger.ts';
import { createAuthTestKit, seedOperator } from './fake-auth.ts';
import { FakeBrowserDriver } from './fake-browser-driver.ts';
import { FakeVaultBackend } from './fake-vault-backend.ts';
import {
  FakeAnalytics,
  FakeFiles,
  FakeLiveControl,
  FakeLogs,
  fakeBlocklist,
  fakeDesktop,
  fakeHealth,
  fakeIdempotency,
  fakeNotifications,
  fakePreferences,
  fakeRealtime,
  SYSTEM_FACTS,
} from './http-fakes.ts';
import { SYSTEM_INFO, seedDataset } from './http-fixtures.ts';
import { InMemoryRepositories } from './in-memory-repos.ts';
import { createVaultRepos } from './in-memory-vault-repos.ts';
import { RecordingEventBus } from './recording-event-bus.ts';

/** Operator password used by every suite. */
export const PASSWORD = 'correct horse battery';
/** Same-origin header set for mutating requests. */
export const ORIGIN = { origin: 'http://localhost', host: 'localhost' };

const noAssets: StaticAssets = {
  available: false,
  indexHtml: async () => null,
  get: async () => null,
};

/** Options of {@link createHttpKit}. */
export interface HttpKitOptions {
  readonly mustChangePassword?: boolean;
  readonly admin?: boolean;
  readonly spa?: StaticAssets;
  readonly vaultConfigured?: boolean;
  readonly seed?: boolean;
}

/** Builds the kit. */
export async function createHttpKit(options: HttpKitOptions = {}) {
  const auth = createAuthTestKit({ mode: 'token' });
  const clock = auth.clock;
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const repos = new InMemoryRepositories();
  const vaultRepos = createVaultRepos();
  const files = new FakeFiles();
  const sessionDirs = sessionDirLayout('/data');
  const driver = new FakeBrowserDriver();
  const sessions = new SessionService({
    clock,
    ids: auth.ids,
    logger,
    bus,
    driver,
    proxyResolver: { resolve: async (r) => r.requested },
    config: testConfig({ maxSessions: 'unbounded' }),
    fs: new FakeSessionDirFs(),
  });
  const broker = new OperatorRequestBroker({
    requests: vaultRepos.requests,
    actions: vaultRepos.actions,
    leases: { pause: () => undefined, resume: () => undefined },
    events: bus,
    clock,
    ids: auth.ids,
    logger,
  });
  const attention = new AttentionService({
    broker,
    clock,
    logger,
    config: { transport: 'http', attentionTimeoutMs: 21_600_000, minAttentionWaitMs: 0 },
  });
  const backend = new FakeVaultBackend(options.vaultConfigured === false ? { kind: 'off' } : {});
  const vault = new VaultService({
    backend,
    broker: null,
    bindings: vaultRepos.bindings,
    policies: vaultRepos.policies,
    audit: vaultRepos.audit,
    confirm: broker,
    clock,
    logger,
  });
  const authService = createAuthService(auth.deps);
  const audit = createAuthAudit(auth.deps);
  const adminAuthenticator = createAuthenticator({
    ...auth.deps,
    audit,
    providers: adminProviderChain(auth.deps),
  });
  const mcpAuthenticator = createAuthenticator({
    ...auth.deps,
    audit,
    providers: mcpProviderChain(auth.deps),
  });
  await seedOperator(auth, {
    password: PASSWORD,
    mustChangePassword: options.mustChangePassword ?? false,
  });
  const events = new RecordingEventBus<DomainEvents>();
  const live = new FakeLiveControl();
  const desktop = fakeDesktop();
  const health = fakeHealth();
  const logs = new FakeLogs();
  const blocklist = fakeBlocklist();
  const idempotency = fakeIdempotency();
  const config = resolveOk();
  const services: HttpServices = {
    sessions,
    repos: { ...repos, operatorActions: vaultRepos.actions },
    analytics: new FakeAnalytics(repos),
    attention,
    vault,
    auth: authService,
    blocklist,
    notifications: fakeNotifications(repos.notifications),
    preferences: fakePreferences(),
    logs,
    logLevel: { set: (spec) => spec },
    system: {
      facts: () => SYSTEM_FACTS,
      configView: () => configView(config.config, config.provenance),
    },
    systemStatus: { snapshot: async () => SYSTEM_INFO },
    health,
    files,
    desktop,
    sessionDirs,
    live,
    realtime: fakeRealtime(),
    idempotency,
    events,
    ids: auth.ids,
    traceViewerAvailable: true,
  };
  if (options.seed !== false) await seedDataset(repos, vaultRepos, files, sessionDirs);
  const http: HttpApp = createHttpApp({
    config: { host: '127.0.0.1', port: 9876, admin: options.admin ?? true, authMode: 'token' },
    services,
    adminAuthenticator,
    mcpAuthenticator,
    mcp: async (_request, principal) => Response.json({ mcp: true, principal: principal.subject }),
    clock,
    ids: auth.ids,
    logger,
    version: '0.1.0',
    spa: options.spa ?? noAssets,
    traceViewer: noAssets,
    peerAddress: () => '127.0.0.1',
  });

  /** Sends a request to the app; `cookie` attaches the session, JSON `body` is serialized. */
  async function request(
    method: string,
    path: string,
    init: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...ORIGIN, ...init.headers };
    if (init.cookie !== undefined) headers['cookie'] = init.cookie;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return http.app.request(`http://localhost${path}`, {
      method,
      headers,
      ...(init.body !== undefined && {
        body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
      }),
    });
  }

  /** Logs in and returns the cookie header value. */
  async function login(): Promise<string> {
    const response = await request('POST', '/api/v1/auth/login', { body: { password: PASSWORD } });
    const setCookie = response.headers.get('set-cookie') ?? '';
    const pair = setCookie.split(';')[0];
    if (response.status !== 200 || pair === undefined)
      throw new Error(`login failed: ${response.status}`);
    return pair;
  }

  return {
    http,
    request,
    login,
    clock,
    logger,
    bus,
    repos,
    vaultRepos,
    sessions,
    driver,
    broker,
    attention,
    backend,
    authKit: auth,
    authService,
    events,
    live,
    desktop,
    health,
    logs,
    blocklist,
    files,
    idempotency,
    sessionDirs,
    services,
  };
}

/** The kit type. */
export type HttpKit = Awaited<ReturnType<typeof createHttpKit>>;
