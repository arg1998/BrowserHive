/** @module test/cli/sitepacks-fakes — a scripted site-pack server for the `sitepacks` suites: one pack view the test edits, the routes the CLI calls, recorded calls and per-route overrides */
import type {
  SitePackDetailResponse,
  SitePackDiffResponse,
  SitePackPending,
  SitePacksResponse,
  SitePackView,
} from '@browserhive/contracts/http';
import type { CliDeps } from '../../src/cli/deps.ts';
import { cliHarness, type HarnessResult, type MemoryFs } from './helpers.ts';

export const URL_FLAGS = ['--url', 'http://127.0.0.1:9876', '--token', 'bh_operator_x'];
export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
export const SHA_L = 'c'.repeat(64);

/** A downloaded bundled candidate. */
export function pendingItem(version: number, sha256 = SHA_B): SitePackPending {
  return {
    version,
    sha256,
    state: 'downloaded',
    size: 2048,
    released: null,
    notes: null,
    source: 'bundled',
    provenance: { kind: 'bundled', release: '0.3.1' },
  };
}

/** LinkedIn approved at v3 (bundled), v4 pending, no local file. */
export function packView(overrides: Partial<SitePackView> = {}): SitePackView {
  return {
    pack_id: 'linkedin.com',
    title: 'LinkedIn',
    domains: ['linkedin.com', 'licdn.com'],
    identity_provider: null,
    approved: {
      version: 3,
      sha256: SHA_A,
      source: 'bundled',
      provenance: { kind: 'bundled', release: '0.3.0' },
      by: 'admin',
      at: 1_758_000_000_000,
    },
    offer: null,
    previous: null,
    pinned_version: null,
    follow: { setting: 'auto', effective: true },
    enabled: true,
    local: null,
    local_override: false,
    pending: [pendingItem(4)],
    used_by: ['tp-abcdefghij'],
    human_only: false,
    write_policy_default: 'confirm',
    stance: 'prohibited',
    verified: {},
    ...overrides,
  };
}

/** A structurally valid pack body for `GET /site-packs/{id}`. */
export const PACK_BODY = {
  schema: 1,
  id: 'linkedin.com',
  version: 3,
  min_client: '0.3.0',
  title: 'LinkedIn',
  domains: ['linkedin.com', 'licdn.com'],
  signed_in: {
    probe: { host: 'www.linkedin.com', path: '/feed/' },
    kind: 'redirect',
    signed_out_redirects: ['www.linkedin.com/uas/login*'],
  },
  guards: [
    { id: 'logout', kind: 'logout', match: { url: 'www.linkedin.com/m/logout' }, action: 'block' },
  ],
  write_policy: {
    default: 'confirm',
    stance: 'prohibited',
    clause: {
      quote: 'You agree not to use bots.',
      url: 'https://www.linkedin.com/legal/user-agreement',
      checked: '2026-11-01',
    },
  },
  verified: { guards: '2026-11-01' },
};

export function diffBody(to: number | null, sha: string): SitePackDiffResponse {
  return {
    from: { version: 3, sha256: SHA_A, source: 'bundled' },
    to: { version: to, sha256: sha, source: to === null ? 'local' : 'bundled' },
    classification: 'unclassified',
    new_domains: [],
    changes: [{ path: 'guards[logout].action', from: 'confirm', to: 'block', class: null }],
  };
}

export interface FakePackServer {
  view: SitePackView;
  calls: { method: string; path: string; body: unknown }[];
  /** Extra routes tried first; `undefined` falls through. */
  routes?: (method: string, path: string, body: unknown) => [number, unknown] | undefined;
}

export function fakePackServer(view: SitePackView = packView()): FakePackServer {
  return { view, calls: [] };
}

export function problem(status: number, code: string, detail: string): unknown {
  return {
    type: `https://browserhive.ai/docs/errors#${code}`,
    title: code,
    status,
    detail,
    code,
    retryable: 'never',
  };
}

function listBody(server: FakePackServer): SitePacksResponse {
  const view = server.view;
  const needing = view.local !== null && view.local.state !== 'approved' ? 1 : 0;
  return {
    data: [view],
    status: {
      enabled: true,
      update_check: false,
      auto_update: false,
      url: null,
      last_check_at: null,
      last_ok_at: null,
      last_outcome: null,
      index_version: null,
      index_expires_at: null,
      stale: false,
      keys_version: null,
      bundled: { version: '0.3.1', built_at: null, count: 11 },
      local: {
        dir: '/data/site-packs/local',
        count: needing,
        signed_layouts: 0,
        needing_approval: needing,
      },
      skipped: [],
      last_load_at: 1,
    },
    pending_count: view.pending.length,
    local_needing_approval: needing,
    now: 2,
  };
}

const BASE = '/api/v1/site-packs';
const PACK = `${BASE}/linkedin.com`;

function route(
  server: FakePackServer,
  method: string,
  path: string,
  body: unknown,
): [number, unknown] {
  const extra = server.routes?.(method, path, body);
  if (extra !== undefined) return extra;
  if (method === 'GET' && (path === BASE || path.startsWith(`${BASE}?`))) {
    return [200, listBody(server)];
  }
  if (method === 'GET' && path === PACK) {
    const detail: SitePackDetailResponse = {
      view: server.view,
      pack: null,
      versions: [{ version: 3, sha256: SHA_A, source: 'bundled', state: 'approved' }],
    };
    return [200, detail];
  }
  if (method === 'GET' && path.startsWith(`${PACK}/diff?to=`)) {
    const to = path.slice(`${PACK}/diff?to=`.length);
    return [200, to === 'local' ? diffBody(null, SHA_L) : diffBody(Number(to), SHA_B)];
  }
  if (path.startsWith(`${PACK}/`)) return [200, { view: server.view }];
  return [404, problem(404, 'SITE_PACK_NOT_FOUND', `no route ${method} ${path}`)];
}

export function http(server: FakePackServer): CliDeps['http'] {
  return async (url, init) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    const [status, json] = route(server, init.method, path, body);
    server.calls.push({ method: init.method, path, body });
    const text = JSON.stringify(json);
    return { status, json: async () => json, text: async () => text };
  };
}

export async function run(
  server: FakePackServer,
  argv: readonly string[],
  options: { answers?: string[]; fs?: MemoryFs } = {},
): Promise<HarnessResult> {
  return cliHarness({
    argv: ['sitepacks', ...argv],
    http: http(server),
    ...(options.answers !== undefined && { answers: options.answers }),
    ...(options.fs !== undefined && { fs: options.fs }),
  });
}

export const writes = (server: FakePackServer): string[] =>
  server.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
