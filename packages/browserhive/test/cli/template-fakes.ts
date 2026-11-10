/** @module test/cli/template-fakes — a scripted template server for the `templates create | finish` suites (routes, 409s on confirm, poll hooks) and a fake operator (clock, sleeps, Enter, Ctrl+C) */
import type { TemplateHealthState } from '@browserhive/contracts/enums';
import type {
  HostView,
  Template,
  TemplateDetailResponse,
  TemplateSiteView,
  TemplateSummary,
} from '@browserhive/contracts/http';
import type { CliDeps } from '../../src/cli/deps.ts';
import { cliHarness, type HarnessResult } from './helpers.ts';

export const ID = 'tp-abcdefghij';
export const BASE = '/api/v1/templates';
export const URL_FLAGS = ['--url', 'http://127.0.0.1:9876', '--token', 'bh_operator_x'];

function siteView(siteId: string, state: TemplateHealthState): TemplateSiteView {
  return {
    site_id: siteId,
    title: siteId,
    pack_id: null,
    pack_version: null,
    enabled: true,
    write_policy: null,
    vault_handle: null,
    auto_relogin: false,
    form: null,
    learned_cookie_names: [],
    health: {
      state,
      checked_at: null,
      changed_at: null,
      reason: null,
      consecutive_inconclusive: 0,
    },
    stopped_at: null,
    device_bound: false,
    added_at: 1,
  };
}

const HOST: HostView = {
  state: 'running',
  since: 1,
  started_at: 1,
  restarts: 0,
  pages: 1,
  parked_pages: 0,
  sandboxed: true,
  profile_secrets: false,
};

/** A fake server holding one template; scripted per test. */
export interface FakeServer {
  sites: Map<string, TemplateHealthState>;
  status: Template['status'];
  unlisted: string[];
  /** Sites whose confirm answers 409 (no new cookie there). */
  refuse: Set<string>;
  /** Status and problem code of `POST …/recording` when it fails. */
  startFails?: { status: number; code: string };
  calls: { method: string; path: string; body: unknown }[];
  /** Removed sign-ins whose site data the server reports as not cleared. */
  uncleared: string[];
  /** Runs on every `GET /templates/{id}` with the number of earlier polls (0 first). */
  onPoll?: (poll: number) => void;
}

export function fakeServer(sites: Record<string, TemplateHealthState>): FakeServer {
  return {
    sites: new Map(Object.entries(sites)),
    status: 'recording',
    unlisted: [],
    refuse: new Set(),
    calls: [],
    uncleared: [],
  };
}

function template(server: FakeServer): Template {
  return {
    template_id: ID,
    name: 'job-hunt',
    display_name: 'job-hunt',
    description: '',
    status: server.status,
    owner: 'operator',
    sites: [...server.sites].map(([site, state]) => siteView(site, state)),
    identity: {
      seed: 'seed',
      locale: 'en-CA',
      languages: ['en-CA'],
      timezone_id: 'America/Toronto',
      country_code: null,
    },
    identity_observed: null,
    channel: 'chromium',
    headless: false,
    stealth: 'standard',
    fingerprint: true,
    humanize: false,
    proxy: null,
    policy: {
      authorized_principals: [],
      max_concurrent: 5,
      unseal: { cookie_values: false, evaluate: false, cookie_writes: false, state_export: false },
      health_interval_ms: 3_600_000,
      prelaunch_check: true,
    },
    agent_windows: 'normal',
    current_version: null,
    checkpoint_at: null,
    checkpoint_size_bytes: null,
    version: 1,
    created_at: 1,
    updated_at: 1,
    last_used_at: null,
    disabled_at: null,
  };
}

function summary(server: FakeServer): TemplateSummary {
  const t = template(server);
  return {
    template_id: ID,
    name: t.name,
    display_name: t.display_name,
    status: t.status,
    channel: t.channel,
    headless: false,
    sites: t.sites.map((s) => ({
      site_id: s.site_id,
      title: s.title,
      health_state: s.health.state,
      checked_at: null,
    })),
    host: { state: 'running', since: 1, pages: 1 },
    in_use: 0,
    cap: 5,
    current_version: null,
    checkpoint_at: null,
    last_used_at: null,
    sealed: true,
  };
}

export function listPage(rows: readonly TemplateSummary[]): unknown {
  return {
    data: rows,
    page: { next_cursor: null, limit: 500 },
    facets: { status: [], host_state: [], health: [] },
    applied: { filters: {}, sort: { key: 'name', dir: 'asc' } },
    meta: { now: 2 },
  };
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

function route(server: FakeServer, method: string, path: string, body: unknown): [number, unknown] {
  const polls = server.calls.filter((c) => c.method === 'GET' && c.path === `${BASE}/${ID}`).length;
  if (method === 'GET' && path.startsWith(`${BASE}?`)) {
    return [200, listPage([summary(server)])];
  }
  if (method === 'POST' && path === BASE) return [201, { template: template(server) }];
  if (method === 'GET' && path === `${BASE}/${ID}`) {
    server.onPoll?.(polls);
    const t = template(server);
    const detail: TemplateDetailResponse = {
      template: t,
      host: HOST,
      sites: t.sites,
      sessions_live: 0,
      parked_pages: [],
      shared_windows: [],
      unlisted_domains: server.unlisted,
      now: 1,
    };
    return [200, detail];
  }
  if (method === 'POST' && path === `${BASE}/${ID}/recording`) {
    const fails = server.startFails;
    if (fails !== undefined) return [fails.status, problem(fails.status, fails.code, 'no display')];
    return [200, { session_id: 'maint-1', host: HOST }];
  }
  if (method === 'POST' && path === `${BASE}/${ID}/recording/confirm`) {
    const site = (body as { site_id: string }).site_id;
    if (server.refuse.has(site)) {
      return [409, problem(409, 'CONFLICT', 'no new sign-in cookie appeared on this site')];
    }
    server.sites.set(site, 'signed_in');
    return [200, { site: siteView(site, 'signed_in') }];
  }
  if (method === 'POST' && path === `${BASE}/${ID}/recording/finish`) {
    for (const [site, state] of server.sites) {
      if (state !== 'signed_in') server.sites.set(site, 'signed_out');
    }
    server.status = 'ready';
    const requested = (body as { remove_sign_ins?: unknown } | undefined)?.remove_sign_ins;
    const removals = Array.isArray(requested) ? requested.map(String) : [];
    const removed_sign_ins = removals.map((domain) => ({
      domain,
      cookies_removed: 1,
      origins_cleared: server.uncleared.includes(domain) ? [] : [`https://${domain}`],
      uncleared_origins: server.uncleared.includes(domain) ? [`https://${domain}`] : [],
    }));
    return [200, { template: template(server), version: null, removed_sign_ins }];
  }
  return [404, problem(404, 'NOT_FOUND', `no route ${method} ${path}`)];
}

export function http(server: FakeServer): CliDeps['http'] {
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

/** Fake time and operator: sleeps advance the clock; Enter and Ctrl+C are pressed by the test. */
export function operator(): {
  wait: CliDeps['wait'];
  clock: CliDeps['clock'];
  enter: () => void;
  interrupt: () => void;
  slept: number[];
} {
  let now = 1_758_000_000_000;
  let pressEnter: (line: string | null) => void = () => undefined;
  let listener: () => void = () => undefined;
  const slept: number[] = [];
  return {
    clock: { now: () => now },
    slept,
    enter: () => pressEnter(''),
    interrupt: () => listener(),
    wait: {
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
      readLine: () => ({
        line: new Promise<string | null>((resolve) => {
          pressEnter = resolve;
        }),
        cancel: () => undefined,
      }),
      onInterrupt: (fn) => {
        listener = fn;
        return () => {
          listener = () => undefined;
        };
      },
    },
  };
}

export async function run(
  server: FakeServer,
  argv: readonly string[],
  options: { answers?: string[]; op?: ReturnType<typeof operator> } = {},
): Promise<HarnessResult> {
  const op = options.op ?? operator();
  return cliHarness({
    argv: ['templates', ...argv],
    http: http(server),
    wait: op.wait,
    overrides: { clock: op.clock },
    ...(options.answers !== undefined && { answers: options.answers }),
  });
}

export const paths = (server: FakeServer): string[] =>
  server.calls.map((c) => `${c.method} ${c.path}`);
