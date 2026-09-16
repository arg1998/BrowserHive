/** @module app/blocklist/blocklist-service — operator URL blocklist: file load/reload (atomic), tool-layer enforcement (`URL_BLOCKED`), request-layer observer, debounced watcher, stats (spec 11 §5, D-22). */

import type { BlockedRequestRow } from '@browserhive/contracts/http';
import { EventId, SessionId } from '@browserhive/contracts/ids';
import {
  Blocklist,
  type BlocklistRules,
  type BlocklistSkipped,
  parseBlocklist,
} from '../../domain/policies/blocklist.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { classifyUrl, sanitizeUrl } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { DomainEvents } from '../events/catalog.ts';

/** File access the service needs (production: `readFile(path, 'utf8')`). */
export interface BlocklistFs {
  readFile(path: string): Promise<string>;
}

/** A file watcher seam (production: `fs.watch`); `onChange` may fire in bursts — the service debounces. */
export interface BlocklistFileWatcher {
  watch(path: string, onChange: () => void): () => void;
}

/** Timer seam for the debounce (defaults to `setTimeout`). */
export type Schedule = (fn: () => void, ms: number) => () => void;

/** One blocked navigation as the driver's route handler reports it (structurally `BlockedUrlObserver` in infra). */
export interface BlockedUrlHit {
  readonly sessionId: string;
  readonly url: string;
  readonly pattern: string;
  readonly source: 'tool' | 'request';
  readonly ts: number;
}

/** Where a tool-layer check happens. */
export interface ToolCheckContext {
  readonly sessionId?: string | undefined;
  readonly tool: string;
  readonly toolEventId?: string | undefined;
}

/** Operator-facing facts for `GET /blocklist` and the System page. */
export interface BlocklistStats {
  readonly path: string | null;
  readonly active: boolean;
  readonly patterns: number;
  readonly skipped: readonly BlocklistSkipped[];
  readonly loadedAt: number | null;
  readonly version: number;
  readonly hits: { readonly tool: number; readonly request: number };
}

/** Dependencies of {@link BlocklistService}. */
export interface BlocklistServiceDeps {
  /** The configured `blocklist` path; `undefined` = no blocklist (never blocks, nothing to watch). */
  readonly path: string | undefined;
  readonly fs: BlocklistFs;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Shared holder (the driver's route reads it too); a fresh one when omitted. */
  readonly holder?: Blocklist;
  readonly degradations?: DegradationReporter;
  /** Resolves a session slug for audit rows; `null` when unknown. */
  readonly sessionSlug?: (sessionId: string) => string | null;
  /** Query keys kept when audit URLs are sanitized (D-20). */
  readonly urlQueryAllowlist?: readonly string[];
  readonly schedule?: Schedule;
}

/** Debounce window of the file watcher (spec 11 §5). */
export const BLOCKLIST_WATCH_DEBOUNCE_MS = 500;

const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  const maybe: { unref?: () => void } = timer;
  maybe.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Loads the operator blocklist and enforces it at the tool boundary. The network layer is the
 * driver's route handler, which reads the same {@link Blocklist} holder and reports hits through
 * {@link BlocklistService.requestObserver}; both layers audit through `blocklist.hit`.
 */
export class BlocklistService {
  readonly holder: Blocklist;
  /** The request-layer sink for the driver's route handler (`source: 'request'`). */
  readonly requestObserver: { blocked(hit: BlockedUrlHit): void };
  private readonly deps: BlocklistServiceDeps;
  private readonly log: Logger;
  private loadedAt: number | null = null;
  private hits = { tool: 0, request: 0 };

  constructor(deps: BlocklistServiceDeps) {
    this.deps = deps;
    this.holder = deps.holder ?? new Blocklist();
    this.log = deps.logger.child({ module: 'blocklist' });
    this.requestObserver = { blocked: (hit) => this.record(hit, null, null) };
  }

  /** True when a blocklist path is configured (the route is installed even while the list is empty). */
  get configured(): boolean {
    return this.deps.path !== undefined;
  }

  /** True when at least one pattern is loaded. */
  get active(): boolean {
    return this.holder.active;
  }

  /**
   * Initial load. A configured-but-unreadable file is fatal (never silently empty).
   *
   * @throws `BLOCKLIST_LOAD_FAILED` `{ path, reason }`.
   */
  async load(): Promise<BlocklistRules> {
    const rules = await this.read();
    this.holder.replace(rules);
    this.loadedAt = this.deps.clock.now();
    this.log.info('blocklist loaded', {
      patterns: rules.entries.length,
      skipped: rules.skipped.length,
    });
    return rules;
  }

  /**
   * Rebuilds the matcher atomically (D-22 hot reload). On failure the previous rules stay in force,
   * a `BLOCKLIST_RELOAD_FAILED` degradation is reported and the typed error is rethrown.
   *
   * @throws `BLOCKLIST_LOAD_FAILED`.
   */
  async reload(): Promise<{ patterns: number; skipped: number }> {
    let rules: BlocklistRules;
    try {
      rules = await this.read();
    } catch (err) {
      this.log.error('blocklist reload failed', { err: serializeError(err) });
      this.deps.degradations?.report({
        code: 'BLOCKLIST_RELOAD_FAILED',
        severity: 'warn',
        message: 'blocklist reload failed; the previous rules stay in force',
        details: { path: this.deps.path ?? null },
      });
      throw err;
    }
    this.holder.replace(rules);
    this.loadedAt = this.deps.clock.now();
    this.deps.degradations?.recovered('BLOCKLIST_RELOAD_FAILED');
    this.deps.bus.publish('blocklist.reloaded', {
      type: 'blocklist.reloaded',
      patterns: rules.entries.length,
      skipped: rules.skipped.length,
      loaded_at: this.loadedAt,
    });
    this.log.info('blocklist reloaded', {
      patterns: rules.entries.length,
      skipped: rules.skipped.length,
    });
    return { patterns: rules.entries.length, skipped: rules.skipped.length };
  }

  /** The matching pattern for `url`, or `null`. Never throws. */
  match(url: string): { pattern: string } | null {
    return this.holder.match(url);
  }

  /**
   * Tool-boundary enforcement, called before the browser is touched so a blocked target costs
   * nothing and leaves no trace in the page's history.
   *
   * @throws `URL_BLOCKED` `{ url, pattern }` (registry message text) after recording the attempt.
   */
  assertAllowed(url: string, context: ToolCheckContext): void {
    const hit = this.holder.match(url);
    if (hit === null) return;
    this.record(
      {
        sessionId: context.sessionId ?? '',
        url,
        pattern: hit.pattern,
        source: 'tool',
        ts: this.deps.clock.now(),
      },
      context.tool,
      context.toolEventId ?? null,
    );
    throw new AppError(
      'URL_BLOCKED',
      { url, pattern: hit.pattern },
      {
        publicMessage: `The URL '${url}' is blocked by the administrator (matched the blocklist pattern '${hit.pattern}'). This is an operator policy, not a transient failure — do not retry this URL, and do not try to reach it by another route. Report it to the user if the task cannot continue.`,
      },
    );
  }

  /**
   * Subscribes to file changes and reloads after a quiet period of `debounceMs`. Reload failures are
   * reported, never thrown out of the watcher. Returns the unsubscribe. No-op without a path.
   */
  watch(watcher: BlocklistFileWatcher, debounceMs = BLOCKLIST_WATCH_DEBOUNCE_MS): () => void {
    const path = this.deps.path;
    if (path === undefined) return () => undefined;
    const schedule = this.deps.schedule ?? defaultSchedule;
    let cancel: (() => void) | undefined;
    const unwatch = watcher.watch(path, () => {
      cancel?.();
      cancel = schedule(() => {
        cancel = undefined;
        void this.reload().catch(() => undefined);
      }, debounceMs);
    });
    return () => {
      cancel?.();
      cancel = undefined;
      unwatch();
    };
  }

  /** Current facts. */
  stats(): BlocklistStats {
    const rules = this.holder.current();
    return {
      path: this.deps.path ?? null,
      active: this.holder.active,
      patterns: rules.entries.length,
      skipped: rules.skipped,
      loadedAt: this.loadedAt,
      version: this.holder.version,
      hits: { ...this.hits },
    };
  }

  private async read(): Promise<BlocklistRules> {
    const path = this.deps.path;
    if (path === undefined) return { entries: [], skipped: [] };
    let body: string;
    try {
      body = await this.deps.fs.readFile(path);
    } catch (err) {
      throw loadFailed(path, serializeError(err).message, err);
    }
    const parsed = parseBlocklist(body);
    if (!parsed.ok) throw loadFailed(path, parsed.error.reason);
    for (const skipped of parsed.value.skipped) {
      this.log.warn('blocklist line skipped', { line: skipped.line, reason: skipped.reason });
    }
    return parsed.value;
  }

  private record(hit: BlockedUrlHit, tool: string | null, toolEventId: string | null): void {
    this.hits[hit.source]++;
    const sessionId = hit.sessionId.length > 0 ? hit.sessionId : null;
    const url = sanitizeUrl(hit.url, { allowQueryKeys: this.deps.urlQueryAllowlist ?? [] });
    const domain = classifyUrl(hit.url).domain;
    const row: BlockedRequestRow = {
      event_id: EventId.parse(this.deps.ids.eventId()),
      session_id: sessionId === null ? null : SessionId.parse(sessionId),
      session_slug: sessionId === null ? null : (this.deps.sessionSlug?.(sessionId) ?? null),
      tool_event_id: toolEventId === null ? null : EventId.parse(toolEventId),
      url,
      domain: domain.length > 0 ? domain : null,
      pattern: hit.pattern,
      source: hit.source,
      tool,
      ts: hit.ts,
    };
    this.log.info('blocked url', {
      sessionId,
      url,
      pattern: hit.pattern,
      source: hit.source,
      tool,
    });
    this.deps.bus.publish('blocklist.hit', { type: 'blocklist.hit', row });
  }
}

function loadFailed(
  path: string,
  reason: string,
  cause?: unknown,
): AppError<'BLOCKLIST_LOAD_FAILED'> {
  return new AppError(
    'BLOCKLIST_LOAD_FAILED',
    { path, reason },
    {
      publicMessage: `Cannot load blocklist ${path}: ${reason}`,
      ...(cause !== undefined && { cause }),
    },
  );
}
