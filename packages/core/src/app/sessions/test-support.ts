/** @module app/sessions/test-support — builders shared by the session suites (not a test). */

import type { CreateSessionRequest } from '../../domain/session/create-request.ts';
import { Session } from '../../domain/session/session.ts';
import type { SessionDirFs } from './profile-dir.ts';
import type { SessionServiceConfig } from './service-deps.ts';

/** A resolved request with the default launch flags; override any field. */
export function testRequest(overrides: Partial<CreateSessionRequest> = {}): CreateSessionRequest {
  return {
    slug: 'shop',
    channel: 'chromium',
    incognito: false,
    headless: true,
    persistenceMode: 'memory',
    restoreProfile: null,
    storageStateName: null,
    launchOptions: undefined,
    contextOptions: undefined,
    disableEvaluate: false,
    vaultEnabled: true,
    stealth: false,
    fingerprint: false,
    humanize: false,
    owner: 'local',
    tenantId: null,
    connectionId: null,
    client: null,
    ...overrides,
  };
}

/** A reserved session at `createdAt` with a 2 h lease and sequential tab ids. */
export function testSession(
  options: {
    id?: string;
    createdAt?: number;
    leaseWindowMs?: number;
    request?: Partial<CreateSessionRequest>;
  } = {},
): Session {
  let tabs = 0;
  return new Session({
    id: options.id ?? 'shop-00000001',
    request: testRequest(options.request),
    createdAt: options.createdAt ?? 1_700_000_000_000,
    leaseWindowMs: options.leaseWindowMs ?? 7_200_000,
    tabId: () => `t-${String(++tabs).padStart(6, '0')}`,
  });
}

/** In-memory {@link SessionDirFs}: records every call; `exists` is false and directories are empty. */
export class FakeSessionDirFs implements SessionDirFs {
  readonly ops: string[] = [];
  readonly dirs = new Set<string>();
  failMkdir = false;

  async mkdir(path: string, mode: number): Promise<void> {
    this.ops.push(`mkdir ${path} ${mode.toString(8)}`);
    if (this.failMkdir) throw new Error('EACCES');
    this.dirs.add(path);
  }

  async rm(path: string): Promise<void> {
    this.ops.push(`rm ${path}`);
    for (const dir of [...this.dirs])
      if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
  }

  async isEmptyOrMissing(): Promise<boolean> {
    return true;
  }

  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path);
  }
}

/** The config every service test starts from (default flags, cap 2, no trace). */
export function testConfig(overrides: Partial<SessionServiceConfig> = {}): SessionServiceConfig {
  return {
    dataDir: '/data',
    sessionLease: 7_200_000,
    sessionCloseTimeout: 1_000,
    defaultHeadless: true,
    defaultChannel: 'chromium',
    persistence: 'memory',
    maxSessions: 2,
    stealth: 'off',
    stealthDriver: 'auto',
    fingerprint: false,
    humanize: false,
    trace: false,
    screenshotTrace: false,
    ...overrides,
  };
}
