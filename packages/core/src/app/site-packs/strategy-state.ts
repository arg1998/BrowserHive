/** @module app/site-packs/strategy-state — the strategy state that survives a restart (spec 13 §9.4; D53, owner decision 2026-11-20): `pace-writes` buckets, the `launch-spacing` turn and the `human-dwell` last action, written through to `template_strategy_state` and read back at boot before any strategy decides, so a restart never refills a write budget or resets a spacing. Budgets and turns are written at once (a crash loses at most the write in flight), dwell times at most every {@link STRATEGY_STATE_FLUSH_MS} (a crash loses at most that much), and everything is flushed on a clean shutdown. Times are wall-clock epoch ms; state already over at boot restores as nothing, and a row that cannot be read is discarded with a warning. `ramp-up` needs no row (its progress is the template's age), and `single-focus` and `serialize-site` stay in memory (they concern live pages and sessions, which a restart ends). */

import { refilled } from '../../domain/site-packs/pace.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  StrategyStateKey,
  StrategyStateRecord,
  StrategyStateRepository,
} from '../../ports/persistence/strategy-state.ts';
import type { DomainEvents } from '../events/catalog.ts';

/** The state each persisted strategy keeps (epoch ms). */
export interface PersistedStrategyStates {
  /** One bucket of a pace rule, with the budget it was taken against. */
  readonly 'pace-writes': {
    readonly tokens: number;
    readonly at: number;
    readonly capacity: number;
    readonly periodMs: number;
  };
  /** The earliest instant the template's next launch may go. */
  readonly 'launch-spacing': { readonly nextAt: number };
  /** The template's last action on the pack's site. */
  readonly 'human-dwell': { readonly lastAt: number };
}

/** A strategy whose state is persisted. */
export type PersistedStrategy = keyof PersistedStrategyStates;

/** The longest a dwell time waits before it is written (the crash bound of `human-dwell`). */
export const STRATEGY_STATE_FLUSH_MS = 2_000;
/** A restored last action older than the longest dwell (`max_ms` ≤ 20 s) no longer matters. */
export const DWELL_RESTORE_MAX_MS = 20_000;
/** A restored turn further ahead than the longest gap (3600 s + 50 % jitter) is clamped to it. */
export const LAUNCH_TURN_MAX_AHEAD_MS = 5_400_000;

/** Where a state belongs: the template, and for page strategies the pack and the strategy's own key. */
export interface StrategyScope {
  readonly templateId: string;
  /** The pack (the site); absent for template-wide state. */
  readonly packId?: string;
  /** The strategy's key inside the pack (a pace rule id). */
  readonly scopeKey?: string;
}

/** What the strategies read and write. */
export type StrategyStateStore = Pick<StrategyState, 'get' | 'restored' | 'set' | 'delete'>;

/** Collaborators of {@link StrategyState}. */
export interface StrategyStateDeps {
  readonly repo: StrategyStateRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `template.removed`: the template's state goes (its rows go with the FK cascade). */
  readonly bus: Pick<EventBus<DomainEvents>, 'subscribe'>;
  /** Runs `fn` after `ms`; returns a cancel. Default: an unref'd `setTimeout`. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

interface Entry {
  readonly key: StrategyStateKey;
  readonly state: unknown;
}

/** The persisted strategy state of every template. */
export class StrategyState {
  readonly #deps: StrategyStateDeps;
  readonly #log: Logger;
  readonly #values = new Map<string, Entry>();
  /** What the boot read (a session's first dwell after a restart counts from it). */
  readonly #restored = new Map<string, Entry>();
  /** Keys to write: their value from `#values`, or a delete when it has none. */
  readonly #dirty = new Map<string, StrategyStateKey>();
  readonly #off: () => void;
  #timer: (() => void) | null = null;
  #urgent = false;
  #stopped = false;
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: StrategyStateDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.strategy-state' });
    this.#off = deps.bus.subscribe('template.removed', ({ payload }) =>
      this.#dropTemplate(payload.template_id),
    );
  }

  /** Reads every row once, at boot, before any strategy decides. Never throws. */
  async restore(): Promise<void> {
    let rows: readonly StrategyStateRecord[];
    try {
      rows = await this.#deps.repo.list();
    } catch (err) {
      this.#log.warn('strategy state unreadable', { err: serializeError(err) });
      return;
    }
    const now = this.#deps.clock.now();
    for (const row of rows) {
      if (!isPersisted(row.strategy)) continue; // a newer binary's strategy: its rows stay
      const key = keyOf(row);
      const state = restoreState(row.strategy, row.stateJson, now);
      if (state === 'expired' || state === 'corrupt') {
        if (state === 'corrupt') {
          this.#log.warn('strategy row discarded', { ...keyFields(row) });
        }
        this.#dirty.set(key, pick(row));
        continue;
      }
      const entry = { key: pick(row), state };
      this.#values.set(key, entry);
      this.#restored.set(key, entry);
    }
    if (this.#dirty.size > 0) this.#schedule('soon');
  }

  /** The current state of one key. */
  get<K extends PersistedStrategy>(
    strategy: K,
    scope: StrategyScope,
  ): PersistedStrategyStates[K] | undefined {
    return this.#values.get(keyOf(fullKey(strategy, scope)))?.state as
      | PersistedStrategyStates[K]
      | undefined;
  }

  /** The state of one key as the boot read it (unchanged by later writes). */
  restored<K extends PersistedStrategy>(
    strategy: K,
    scope: StrategyScope,
  ): PersistedStrategyStates[K] | undefined {
    return this.#restored.get(keyOf(fullKey(strategy, scope)))?.state as
      | PersistedStrategyStates[K]
      | undefined;
  }

  /** Sets one key; `now` writes it at once, `soon` within {@link STRATEGY_STATE_FLUSH_MS}. */
  set<K extends PersistedStrategy>(
    strategy: K,
    scope: StrategyScope,
    state: PersistedStrategyStates[K],
    when: 'now' | 'soon',
  ): void {
    const key = fullKey(strategy, scope);
    const k = keyOf(key);
    this.#values.set(k, { key, state });
    this.#dirty.set(k, key);
    this.#schedule(when);
  }

  /** Forgets one key (its row is deleted with the next write). */
  delete(strategy: PersistedStrategy, scope: StrategyScope): void {
    const key = fullKey(strategy, scope);
    const k = keyOf(key);
    if (!this.#values.delete(k)) return;
    this.#dirty.set(k, key);
    this.#schedule('soon');
  }

  /** Writes every pending change; resolves when they are written (failures are logged). */
  flush(): Promise<void> {
    this.#chain = this.#chain.then(() => this.#write());
    return this.#chain;
  }

  /** The clean shutdown: unsubscribes, cancels the timer and writes what is pending. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#off();
    this.#timer?.();
    this.#timer = null;
    await this.flush();
  }

  #schedule(when: 'now' | 'soon'): void {
    if (this.#stopped) return;
    if (when === 'now') {
      if (this.#urgent) return;
      this.#urgent = true;
      queueMicrotask(() => {
        this.#urgent = false;
        void this.flush();
      });
      return;
    }
    if (this.#timer !== null) return;
    const schedule = this.#deps.schedule ?? unrefTimeout;
    this.#timer = schedule(() => {
      this.#timer = null;
      void this.flush();
    }, STRATEGY_STATE_FLUSH_MS);
  }

  async #write(): Promise<void> {
    const pending = [...this.#dirty];
    this.#dirty.clear();
    const now = this.#deps.clock.now();
    for (const [k, key] of pending) {
      const entry = this.#values.get(k);
      try {
        if (entry === undefined) await this.#deps.repo.remove(key);
        else {
          await this.#deps.repo.put({
            ...entry.key,
            stateJson: encodeState(entry.key.strategy as PersistedStrategy, entry.state),
            updatedAt: now,
          });
        }
      } catch (err) {
        // Not retried: a template deleted meanwhile fails its FK for good; the next change rewrites it.
        this.#log.warn('strategy state not saved', { ...keyFields(key), err: serializeError(err) });
      }
    }
  }

  #dropTemplate(templateId: string): void {
    const prefix = `${templateId}\u0000`;
    for (const map of [this.#values, this.#restored, this.#dirty]) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    }
  }
}

function fullKey(strategy: PersistedStrategy, scope: StrategyScope): StrategyStateKey {
  return {
    templateId: scope.templateId,
    strategy,
    packId: scope.packId ?? '',
    scopeKey: scope.scopeKey ?? '',
  };
}

function keyOf(key: StrategyStateKey): string {
  return [key.templateId, key.strategy, key.packId, key.scopeKey].join('\u0000');
}

function pick(key: StrategyStateKey): StrategyStateKey {
  return {
    templateId: key.templateId,
    strategy: key.strategy,
    packId: key.packId,
    scopeKey: key.scopeKey,
  };
}

function keyFields(key: StrategyStateKey): Record<string, string> {
  return {
    templateId: key.templateId,
    strategy: key.strategy,
    packId: key.packId,
    scopeKey: key.scopeKey,
  };
}

const PERSISTED: readonly string[] = ['pace-writes', 'launch-spacing', 'human-dwell'];

function isPersisted(strategy: string): strategy is PersistedStrategy {
  return PERSISTED.includes(strategy);
}

function unrefTimeout(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

/** The row's JSON (snake_case, like every JSON column). */
function encodeState(strategy: PersistedStrategy, state: unknown): string {
  switch (strategy) {
    case 'pace-writes': {
      const s = state as PersistedStrategyStates['pace-writes'];
      return JSON.stringify({
        tokens: s.tokens,
        at: s.at,
        capacity: s.capacity,
        period_ms: s.periodMs,
      });
    }
    case 'launch-spacing':
      return JSON.stringify({
        next_at: (state as PersistedStrategyStates['launch-spacing']).nextAt,
      });
    case 'human-dwell':
      return JSON.stringify({ last_at: (state as PersistedStrategyStates['human-dwell']).lastAt });
  }
}

/**
 * A row's state at `now`: `expired` when it no longer constrains anything (a full bucket, a turn
 * that has come, a dwell long over), `corrupt` when it cannot be read. A time ahead of `now` (the
 * clock went back) is clamped so a skewed clock cannot freeze a template.
 */
export function restoreState(
  strategy: PersistedStrategy,
  json: string,
  now: number,
): PersistedStrategyStates[PersistedStrategy] | 'expired' | 'corrupt' {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return 'corrupt';
  }
  if (typeof raw !== 'object' || raw === null) return 'corrupt';
  const field = (name: string): number | null => {
    const v = (raw as Record<string, unknown>)[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  switch (strategy) {
    case 'pace-writes': {
      const [tokens, at, capacity, periodMs] = ['tokens', 'at', 'capacity', 'period_ms'].map(field);
      if (tokens == null || at == null || capacity == null || periodMs == null) return 'corrupt';
      if (capacity <= 0 || periodMs <= 0) return 'corrupt';
      const bucket = refilled({ tokens, at: Math.min(at, now) }, { capacity, periodMs }, now);
      return bucket.tokens >= capacity ? 'expired' : { ...bucket, capacity, periodMs };
    }
    case 'launch-spacing': {
      const nextAt = field('next_at');
      if (nextAt === null) return 'corrupt';
      return nextAt <= now
        ? 'expired'
        : { nextAt: Math.min(nextAt, now + LAUNCH_TURN_MAX_AHEAD_MS) };
    }
    case 'human-dwell': {
      const lastAt = field('last_at');
      if (lastAt === null) return 'corrupt';
      return now - lastAt > DWELL_RESTORE_MAX_MS ? 'expired' : { lastAt: Math.min(lastAt, now) };
    }
  }
}
