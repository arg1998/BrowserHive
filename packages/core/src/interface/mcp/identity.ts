/** @module interface/mcp/identity — who is on the other end of an MCP connection, resolved per request (spec 02 §1.4, D-30): the precedence ladder over the stdio environment, headers, the URL, `_meta`, `clientInfo` and the User-Agent; the capped meta bag; conflicts; and the per-connection cache that keeps `mcp_connections` current. Self-reported observability: nothing here feeds a decision. */

import {
  capMetaBag,
  type DeclaredSource,
  HARNESS_QUERY_PARAM,
  type HarnessSource,
  harnessFromClientName,
  harnessFromUserAgent,
  IDENTITY_HEADERS,
  IDENTITY_META_PREFIXES,
  INJECTED_ENV_HARNESSES,
  META_HEADER_PREFIX,
  normalizeHarness,
  RESERVED_META_NAMES,
  UNKNOWN_HARNESS,
} from '@browserhive/contracts/harness';
import type { SessionClientInfo } from '../../domain/session/client-info.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { McpConnectionPatch } from '../../ports/persistence/operations.ts';
import type { HarnessConflictRecord, JsonObject } from '../../ports/persistence/records.ts';

/** Longest model or workspace value kept (characters); longer values are cut. */
export const DECLARED_VALUE_MAX = 200;

/** Header names and values of one request, lower-cased names, first value, trimmed. */
export type HeaderBag = ReadonlyMap<string, string>;

/**
 * Normalises `Headers` (fetch) or the SDK's `IsomorphicHeaders` record into a {@link HeaderBag};
 * blank values are dropped.
 */
export function headerBag(
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
): HeaderBag {
  const bag = new Map<string, string>();
  if (headers === undefined) return bag;
  const put = (name: string, raw: string | readonly string[] | undefined) => {
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value !== undefined && value !== '' && !bag.has(name.toLowerCase())) {
      bag.set(name.toLowerCase(), value);
    }
  };
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      put(name, value);
    });
  } else {
    for (const [name, value] of Object.entries(headers)) put(name, value);
  }
  return bag;
}

/** What one request carries (HTTP: its headers and URL; any transport: the message's `_meta`). */
export interface RequestSignals {
  readonly headers?: HeaderBag;
  readonly url?: URL | string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** The `initialize` parameters the identity reads. */
export interface InitializeSignals {
  readonly clientInfo?: {
    readonly name?: string;
    readonly version?: string;
    readonly title?: string;
  };
  readonly protocolVersion?: string;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** Everything known about a connection before any tool call. */
export interface ConnectionSignals {
  readonly transport: 'http' | 'stdio';
  /** stdio: the process environment (identity variables and harness-injected ones). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** HTTP: the `initialize` request's headers and URL. */
  readonly request?: RequestSignals;
  readonly initialize?: InitializeSignals;
  /** HTTP: the client IP (03 §2, honouring `trustedProxies`). */
  readonly ip?: string | null;
}

/** The identity resolved for one request. */
export interface ResolvedIdentity {
  readonly harness: string;
  readonly harnessSource: HarnessSource;
  /** The winning signal's raw value (`null` for `none`). */
  readonly harnessValue: string | null;
  readonly conflicts: readonly HarnessConflictRecord[];
  readonly model: string | null;
  readonly modelSource: DeclaredSource | null;
  readonly workspace: string | null;
  readonly workspaceSource: DeclaredSource | null;
  readonly meta: Readonly<Record<string, string>>;
  readonly metaDropped: number;
  readonly clientName: string | null;
  readonly clientVersion: string | null;
  readonly clientTitle: string | null;
  readonly protocolVersion: string | null;
  readonly capabilities: JsonObject | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

interface Candidate {
  readonly source: HarnessSource;
  readonly value: string;
  readonly harness: string;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out === '' ? null : out.slice(0, DECLARED_VALUE_MAX);
}

function firstHeader(headers: HeaderBag | undefined, names: readonly string[]): string | null {
  for (const name of names) {
    const value = trimmed(headers?.get(name));
    if (value !== null) return value;
  }
  return null;
}

/** `_meta['ai.browserhive/<name>']`, then the `browserhive.ai/` alias. */
function metaField(
  meta: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string | null {
  if (meta === undefined) return null;
  for (const prefix of IDENTITY_META_PREFIXES) {
    const value = trimmed(meta[`${prefix}${name}`]);
    if (value !== null) return value;
  }
  return null;
}

function metaBagEntries(meta: Readonly<Record<string, unknown>> | undefined): [string, unknown][] {
  if (meta === undefined) return [];
  const out: [string, unknown][] = [];
  for (const prefix of IDENTITY_META_PREFIXES) {
    for (const [key, value] of Object.entries(meta)) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (!RESERVED_META_NAMES.includes(name)) out.push([name, value]);
    }
  }
  return out;
}

function headerBagEntries(headers: HeaderBag | undefined): [string, unknown][] {
  if (headers === undefined) return [];
  const out: [string, unknown][] = [];
  for (const [name, value] of headers) {
    if (name.startsWith(META_HEADER_PREFIX) && name.length > META_HEADER_PREFIX.length) {
      out.push([name.slice(META_HEADER_PREFIX.length), value]);
    }
  }
  return out;
}

function queryHarness(url: URL | string | undefined): string | null {
  if (url === undefined) return null;
  try {
    const parsed = typeof url === 'string' ? new URL(url, 'http://localhost') : url;
    return trimmed(parsed.searchParams.get(HARNESS_QUERY_PARAM));
  } catch {
    return null;
  }
}

function mergeHeaders(base: HeaderBag | undefined, over: HeaderBag | undefined): HeaderBag {
  if (base === undefined) return over ?? new Map();
  if (over === undefined) return base;
  return new Map([...base, ...over]);
}

function injected(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

function declared(source: HarnessSource, raw: string | null): Candidate[] {
  if (raw === null) return [];
  const harness = normalizeHarness(raw);
  return harness === null ? [] : [{ source, value: raw, harness }];
}

/**
 * Resolves the identity of one request (spec 02 §1.4). Pure: the same signals always give the
 * same answer. A request's own headers and `?harness=` win over the `initialize` request's, which
 * still fill the gaps; the call's `_meta` is read before the `initialize` `_meta`.
 */
export function resolveIdentity(
  connection: ConnectionSignals,
  request: RequestSignals = {},
): ResolvedIdentity {
  const env = connection.env ?? {};
  // A request's own headers win per name; the `initialize` request's fill the gaps, so a client
  // that declares only once, on `initialize`, keeps its declaration for the connection.
  const headers = mergeHeaders(connection.request?.headers, request.headers);
  const callMeta = request.meta;
  const initMeta = connection.initialize?.meta;
  const clientInfo = connection.initialize?.clientInfo;
  const userAgent = trimmed(headers?.get('user-agent'));

  const candidates: Candidate[] = [
    ...declared('env', trimmed(env['BROWSERHIVE_HARNESS'])),
    ...declared('header', firstHeader(headers, IDENTITY_HEADERS.harness)),
    ...INJECTED_ENV_HARNESSES.filter(([name]) => injected(env[name])).map(
      ([name, harness]): Candidate => ({ source: 'injected_env', value: name, harness }),
    ),
    ...declared('url', queryHarness(request.url) ?? queryHarness(connection.request?.url)),
    ...declared('meta', metaField(callMeta, 'harness')),
    ...declared('meta', metaField(initMeta, 'harness')),
  ];
  const clientName = trimmed(clientInfo?.name);
  if (clientName !== null) {
    const harness = harnessFromClientName(clientName);
    if (harness !== UNKNOWN_HARNESS)
      candidates.push({ source: 'client_info', value: clientName, harness });
  }
  const uaHarness = harnessFromUserAgent(userAgent);
  if (userAgent !== null && uaHarness !== null) {
    candidates.push({ source: 'user_agent', value: userAgent, harness: uaHarness });
  }
  const winner = candidates[0];
  const conflicts: HarnessConflictRecord[] = [];
  if (winner !== undefined) {
    for (const c of candidates.slice(1)) {
      if (c.harness === winner.harness) continue;
      if (conflicts.some((x) => x.source === c.source && x.value === c.value)) continue;
      conflicts.push({ source: c.source, value: c.value, harness: c.harness });
    }
  }

  const pick = (
    headerNames: readonly string[],
    envName: string,
    metaName: string,
  ): { value: string | null; source: DeclaredSource | null } => {
    const fromEnv = trimmed(env[envName]);
    if (fromEnv !== null) return { value: fromEnv, source: 'env' };
    const fromHeader = firstHeader(headers, headerNames);
    if (fromHeader !== null) return { value: fromHeader, source: 'header' };
    const fromMeta = metaField(callMeta, metaName) ?? metaField(initMeta, metaName);
    if (fromMeta !== null) return { value: fromMeta, source: 'meta' };
    return { value: null, source: null };
  };
  const model = pick(IDENTITY_HEADERS.model, 'BROWSERHIVE_MODEL', 'model');
  const workspace = pick(IDENTITY_HEADERS.workspace, 'BROWSERHIVE_WORKSPACE', 'workspace');
  const bag = capMetaBag([
    ...metaBagEntries(callMeta),
    ...metaBagEntries(initMeta),
    ...headerBagEntries(headers),
  ]);
  const capabilities = connection.initialize?.capabilities;
  return {
    harness: winner?.harness ?? UNKNOWN_HARNESS,
    harnessSource: winner?.source ?? 'none',
    harnessValue: winner?.value ?? null,
    conflicts,
    model: model.value,
    modelSource: model.source,
    workspace: workspace.value,
    workspaceSource: workspace.source,
    meta: bag.meta,
    metaDropped: bag.dropped,
    clientName,
    clientVersion: trimmed(clientInfo?.version),
    clientTitle: trimmed(clientInfo?.title),
    protocolVersion: trimmed(connection.initialize?.protocolVersion),
    capabilities:
      capabilities === undefined ? null : (JSON.parse(JSON.stringify(capabilities)) as JsonObject),
    userAgent,
    ip: connection.ip ?? null,
  };
}

/** The per-call client identity tools see (`ToolCallContext.client`). */
export function clientOfIdentity(identity: ResolvedIdentity): SessionClientInfo {
  return {
    name: identity.clientName,
    version: identity.clientVersion,
    title: identity.clientTitle,
    agentName: identity.workspace,
    workspace: identity.workspace,
    model: identity.model,
    modelSource: identity.modelSource,
    harness: identity.harness,
    harnessSource: identity.harnessSource,
    protocolVersion: identity.protocolVersion,
    meta: identity.meta,
  };
}

/** The `mcp_connections` columns an identity fills (`agent_name` mirrors `workspace`). */
export function connectionPatchOf(identity: ResolvedIdentity): McpConnectionPatch {
  return {
    harness: identity.harness,
    harnessSource: identity.harnessSource,
    conflicts: identity.conflicts,
    model: identity.model,
    modelSource: identity.modelSource,
    workspace: identity.workspace,
    agentName: identity.workspace,
    meta: identity.meta,
    clientName: identity.clientName,
    clientVersion: identity.clientVersion,
    clientTitle: identity.clientTitle,
    protocolVersion: identity.protocolVersion,
    capabilities: identity.capabilities,
    userAgent: identity.userAgent,
  };
}

function fingerprint(identity: ResolvedIdentity): string {
  return JSON.stringify(connectionPatchOf(identity));
}

/** Options of {@link ConnectionIdentity}. */
export interface ConnectionIdentityOptions {
  readonly connectionId: string;
  readonly signals: ConnectionSignals;
  readonly logger: Logger;
  /** Write-through to the connection row; failures are logged, never thrown. */
  readonly persist?: (patch: McpConnectionPatch) => Promise<unknown> | undefined;
}

/**
 * One connection's identity: resolved per request from the connection's signals plus the
 * request's own, cached, and written to the connection row whenever the resolution changes.
 * Conflicts and an over-full meta bag are logged once per connection at `info`.
 */
export class ConnectionIdentity {
  readonly #options: ConnectionIdentityOptions;
  readonly #log: Logger;
  #signals: ConnectionSignals;
  #current: ResolvedIdentity;
  #persisted: string;
  #loggedConflicts = false;
  #loggedMeta = false;

  constructor(options: ConnectionIdentityOptions) {
    this.#options = options;
    this.#log = options.logger.child({ module: 'mcp.identity' });
    this.#signals = options.signals;
    this.#current = resolveIdentity(this.#signals);
    this.#persisted = fingerprint(this.#current);
    this.#report(this.#current);
  }

  /** The latest resolution. */
  get current(): ResolvedIdentity {
    return this.#current;
  }

  /** Records what `initialize` revealed (both transports) and re-resolves. */
  initialize(params: InitializeSignals): ResolvedIdentity {
    this.#signals = { ...this.#signals, initialize: params };
    return this.#update(resolveIdentity(this.#signals));
  }

  /** Resolves one request (a tool call) and caches the result on the connection. */
  resolve(request: RequestSignals = {}): ResolvedIdentity {
    return this.#update(resolveIdentity(this.#signals, request));
  }

  #update(next: ResolvedIdentity): ResolvedIdentity {
    this.#current = next;
    this.#report(next);
    const print = fingerprint(next);
    if (print !== this.#persisted) {
      this.#persisted = print;
      void this.#options.persist?.(connectionPatchOf(next))?.catch((err: unknown) =>
        this.#log.warn('connection write failed', {
          connectionId: this.#options.connectionId,
          err: serializeError(err),
        }),
      );
    }
    return next;
  }

  #report(identity: ResolvedIdentity): void {
    if (identity.conflicts.length > 0 && !this.#loggedConflicts) {
      this.#loggedConflicts = true;
      this.#log.info('harness signals disagree', {
        connectionId: this.#options.connectionId,
        harness: identity.harness,
        source: identity.harnessSource,
        shadowed: identity.conflicts.map((c) => `${c.source}=${c.harness}`).join(', '),
      });
    }
    if (identity.metaDropped > 0 && !this.#loggedMeta) {
      this.#loggedMeta = true;
      this.#log.info('meta bag capped', {
        connectionId: this.#options.connectionId,
        dropped: identity.metaDropped,
      });
    }
  }
}
