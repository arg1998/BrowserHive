/** @module infra/browsers/page-attribution.property.test — seeded property suite of the attribution invariant (spec 13 §3.4, §17 T0c) over a fake host model: 1 000 cases fast, 100 000 nightly. */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'playwright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { asPage, FakePage } from '../../../test/helpers/fake-page.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import {
  PARKED,
  type PageOwner,
  sameOwner,
  sessionOwner,
  type TargetFacts,
} from './page-attribution.ts';
import { ATTRIBUTION_HOLD_MS, HostPageDispatcher } from './page-dispatcher.ts';

/**
 * Random operation sequences against the real {@link HostPageDispatcher} on a fake host: views
 * open and close, windows are created through claims (the response before or after Playwright's
 * adoption, or late enough to need the hold), sites open popups (`window.open`, `noopener`,
 * `target=_blank` from a popup window, an opener that closes before its child is adopted), the
 * operator and service workers open pages in agent windows, pages are restored at start, tabs
 * close, renderer crashes close pages of several sessions at once, time passes and the host
 * crashes. After every step the suite checks the invariant of spec 13 §3.4:
 *
 * - a page is in at most one session's registry, and only in its owner's;
 * - an attribution never changes, before or after the page closes;
 * - a page reaches a registry only once attributed to that session; a held or parked page is in none;
 * - a page belongs to the session that claimed it, or to its opener's owner, else it is parked;
 * - the window a page appears in never decides (operator tabs in agent windows stay parked).
 *
 * `BROWSERHIVE_NIGHTLY=1` runs 100 000 cases. Seeds are fixed so a failure is reproducible.
 */
const NIGHTLY = process.env['BROWSERHIVE_NIGHTLY'] === '1';
const CASES = NIGHTLY ? 100_000 : 1_000;
const STEPS = 30;
/** 1 000 cases take about 0.3 s; the nightly run needs well over Bun's 5 s default. */
const TIMEOUT_MS = NIGHTLY ? 600_000 : 30_000;

/** Seeded xorshift so a failure is reproducible. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

type Origin =
  | { readonly kind: 'claim'; readonly sessionId: string }
  | { readonly kind: 'opener'; readonly openerId: string }
  | { readonly kind: 'none'; readonly why: string };

interface ModelTarget {
  readonly id: string;
  readonly fake: FakePage;
  readonly page: Page;
  readonly origin: Origin;
  /** The window the model places the page in; never an input of the dispatcher. */
  readonly window: number;
  /** A claim that was refused or never sent (its hold expired, or its session closed first). */
  claimMissed: boolean;
}

interface ModelSession {
  readonly id: string;
  readonly registry: Set<Page>;
  readonly windows: number[];
  open: boolean;
}

interface PendingCreate {
  readonly target: ModelTarget;
  readonly sessionId: string;
  readonly settle: () => void;
}

const OPS = [
  'openView',
  'newTabViaClaim',
  'resolvePending',
  'windowOpen',
  'noopenerPopup',
  'blankFromPopup',
  'openerClosesFirst',
  'serviceWorkerWindow',
  'operatorCtrlT',
  'closeTab',
  'closeView',
  'rendererCrash',
  'advanceTime',
  'factsArrive',
] as const;
type Op = (typeof OPS)[number];

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** The fake host: real dispatcher, model sessions with tab registries, and the expected owners. */
class HostModel {
  readonly clock = new FakeClock();
  readonly facts = new Map<Page, TargetFacts>();
  readonly dispatcher: HostPageDispatcher;
  readonly targets: ModelTarget[] = [];
  readonly byId = new Map<string, ModelTarget>();
  readonly sessions: ModelSession[] = [];
  readonly pending: PendingCreate[] = [];
  /** `Target.getTargetInfo` answers not yet delivered (a template host reads facts over CDP). */
  readonly slowFacts: Array<{ readonly id: string; readonly deliver: () => void }> = [];
  /** First attribution observed per target id (kept after close). */
  readonly firstOwner = new Map<string, PageOwner>();
  readonly violations: string[] = [];
  readonly trace: string[] = [];
  private nextTarget = 0;
  private nextWindow = 0;

  constructor(
    private readonly next: () => number,
    fallback: PageOwner = PARKED,
  ) {
    this.dispatcher = new HostPageDispatcher({
      fallback,
      factsOf: (page) => {
        const facts = this.facts.get(page);
        if (facts === undefined) throw new Error('page without facts');
        if (this.next() >= 0.25) return facts;
        return new Promise<TargetFacts>((resolve) => {
          this.slowFacts.push({ id: facts.targetId, deliver: () => resolve(facts) });
        });
      },
      clock: this.clock,
      logger: createCollectingLogger(),
    });
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[Math.floor(this.next() * items.length)];
  }

  livePages(): ModelTarget[] {
    return this.targets.filter((t) => !t.fake.isClosed());
  }

  openSessions(): ModelSession[] {
    return this.sessions.filter((s) => s.open);
  }

  newTarget(openerId: string | null, origin: Origin, window: number): ModelTarget {
    const id = `T${this.nextTarget++}`;
    const fake = new FakePage();
    const target: ModelTarget = {
      id,
      fake,
      page: asPage(fake),
      origin,
      window,
      claimMissed: false,
    };
    this.facts.set(target.page, { targetId: id, openerId });
    this.targets.push(target);
    this.byId.set(id, target);
    return target;
  }

  adopt(target: ModelTarget): void {
    this.dispatcher.adopt(target.page);
    this.observe();
  }

  /** Delivers one slow `Target.getTargetInfo` answer (all of them with `all`). */
  async deliverFacts(all: boolean): Promise<void> {
    const batch = all ? this.slowFacts.splice(0) : [];
    if (!all) {
      const one = this.pick(this.slowFacts);
      if (one === undefined) return;
      this.slowFacts.splice(this.slowFacts.indexOf(one), 1);
      batch.push(one);
    }
    for (const entry of batch) {
      this.trace.push(`factsArrive ${entry.id}`);
      entry.deliver();
      await flush();
      this.observe();
    }
  }

  async close(target: ModelTarget): Promise<void> {
    await target.fake.close();
    this.observe();
  }

  openView(id = `S${this.sessions.length}`): ModelSession {
    const session: ModelSession = {
      id,
      registry: new Set(),
      windows: [],
      open: true,
    };
    this.sessions.push(session);
    this.dispatcher.onAttributed(session.id, (page) => {
      const owner = this.dispatcher.ownerOf(page);
      if (owner === undefined || !sameOwner(owner, sessionOwner(session.id))) {
        this.violations.push(`page delivered to ${session.id} before it was attributed to it`);
      }
      if (!session.open) this.violations.push(`page delivered to closed ${session.id}`);
      session.registry.add(page);
      // What `TabRegistry.add` does: a closed page leaves the registry on its own.
      page.once('close', () => session.registry.delete(page));
    });
    return session;
  }

  /** `Target.createTarget {background: true}` for `session`, in one of three timings. */
  createWindow(session: ModelSession): void {
    const window = this.nextWindow++;
    session.windows.push(window);
    const target = this.newTarget(null, { kind: 'claim', sessionId: session.id }, window);
    const timing = this.pick(['claimFirst', 'adoptFirst', 'deferred'] as const) ?? 'claimFirst';
    this.trace.push(`createWindow ${session.id} ${target.id} ${timing}`);
    const settle = this.dispatcher.beginCreate();
    if (timing === 'claimFirst') {
      this.claim(target, session.id);
      settle();
      this.adopt(target);
      return;
    }
    this.adopt(target);
    if (timing === 'adoptFirst') {
      this.claim(target, session.id);
      settle();
      this.observe();
      return;
    }
    this.pending.push({ target, sessionId: session.id, settle });
  }

  claim(target: ModelTarget, sessionId: string): void {
    if (!this.dispatcher.claim(target.id, sessionOwner(sessionId))) target.claimMissed = true;
    this.observe();
  }

  async popup(opener: ModelTarget, why: string): Promise<void> {
    // Placement is not attribution: the popup may land in any window, another session's included.
    const window = this.pick([opener.window, ...this.sessions.flatMap((s) => s.windows)]) ?? 0;
    const target = this.newTarget(opener.id, { kind: 'opener', openerId: opener.id }, window);
    this.trace.push(`${why} ${opener.id} -> ${target.id}`);
    this.adopt(target);
  }

  async run(op: Op): Promise<void> {
    switch (op) {
      case 'openView': {
        this.createWindow(this.openView());
        return;
      }
      case 'newTabViaClaim': {
        const session = this.pick(this.openSessions());
        if (session !== undefined) this.createWindow(session);
        return;
      }
      case 'resolvePending': {
        const entry = this.pick(this.pending);
        if (entry === undefined) return;
        this.pending.splice(this.pending.indexOf(entry), 1);
        this.trace.push(`resolvePending ${entry.target.id}`);
        const session = this.sessions.find((s) => s.id === entry.sessionId);
        if (session?.open === true) this.claim(entry.target, entry.sessionId);
        else entry.target.claimMissed = true;
        entry.settle();
        this.observe();
        // A refused claim closes the target (the launch fails, spec 13 §3.3).
        if (entry.target.claimMissed && !entry.target.fake.isClosed())
          await this.close(entry.target);
        return;
      }
      case 'windowOpen':
      case 'noopenerPopup': {
        // CDP sets `openerId` for `noopener` popups too; both reach the dispatcher the same way.
        const opener = this.pick(this.livePages());
        if (opener !== undefined) await this.popup(opener, op);
        return;
      }
      case 'blankFromPopup': {
        const opener = this.pick(this.livePages().filter((t) => t.origin.kind === 'opener'));
        if (opener !== undefined) await this.popup(opener, op);
        return;
      }
      case 'openerClosesFirst': {
        // `window.open(url); window.close()`: the opener is gone before its child is adopted.
        const opener = this.pick(this.livePages());
        if (opener === undefined) return;
        const window = this.pick(this.sessions.flatMap((s) => s.windows)) ?? opener.window;
        const target = this.newTarget(opener.id, { kind: 'opener', openerId: opener.id }, window);
        this.trace.push(`openerClosesFirst ${opener.id} -> ${target.id}`);
        await this.close(opener);
        this.adopt(target);
        return;
      }
      case 'serviceWorkerWindow': {
        const target = this.newTarget(
          null,
          { kind: 'none', why: 'service worker' },
          this.nextWindow++,
        );
        this.trace.push(`serviceWorkerWindow ${target.id}`);
        this.adopt(target);
        return;
      }
      case 'operatorCtrlT': {
        // A tab the operator opens by hand inside an agent's window is still parked.
        const window = this.pick(this.sessions.flatMap((s) => s.windows)) ?? this.nextWindow++;
        const target = this.newTarget(null, { kind: 'none', why: 'operator tab' }, window);
        this.trace.push(`operatorCtrlT ${target.id} in window ${window}`);
        this.adopt(target);
        return;
      }
      case 'closeTab': {
        const target = this.pick(this.livePages());
        if (target === undefined) return;
        this.trace.push(`closeTab ${target.id}`);
        await this.close(target);
        return;
      }
      case 'closeView': {
        const session = this.pick(this.openSessions());
        if (session === undefined) return;
        this.trace.push(`closeView ${session.id}`);
        for (const page of this.dispatcher.pagesOf(session.id)) {
          const target = this.livePages().find((t) => t.page === page);
          if (target !== undefined) await this.close(target);
        }
        session.open = false;
        this.dispatcher.releaseSession(session.id);
        // Its claims go with it (spec 13 §3.5): a window it had not received yet is parked.
        for (const target of this.targets) {
          const origin = target.origin;
          if (origin.kind !== 'claim' || origin.sessionId !== session.id) continue;
          if (!this.firstOwner.has(target.id)) target.claimMissed = true;
        }
        this.observe();
        return;
      }
      case 'rendererCrash': {
        // Same-site pages share a renderer: one crash can close pages of several sessions.
        const victims = this.livePages().filter(() => this.next() < 0.4);
        this.trace.push(`rendererCrash ${victims.map((t) => t.id).join(',')}`);
        for (const target of victims) await this.close(target);
        return;
      }
      case 'advanceTime': {
        // CDP answers in milliseconds: every slow answer is in before a hold can expire.
        await this.deliverFacts(true);
        this.trace.push('advanceTime');
        // Every page held now was adopted at least a hold ago once time moves: a window whose
        // `createTarget` has not answered is parked, and its late claim will be refused.
        for (const entry of this.pending) {
          if (!this.firstOwner.has(entry.target.id)) entry.target.claimMissed = true;
        }
        await this.clock.advance(ATTRIBUTION_HOLD_MS);
        await flush();
        this.observe();
        return;
      }
      case 'factsArrive': {
        await this.deliverFacts(false);
        return;
      }
    }
  }

  /** The host browser exits: every page closes at once. */
  async hostCrash(): Promise<void> {
    await this.deliverFacts(true);
    this.trace.push('hostCrash');
    for (const target of this.livePages()) await this.close(target);
    for (const entry of this.pending.splice(0)) entry.settle();
    this.observe();
  }

  /** Records first attributions and checks the invariant at this instant. */
  observe(): void {
    for (const target of this.targets) {
      const owner = this.dispatcher.ownerOf(target.page);
      const first = this.firstOwner.get(target.id);
      if (owner !== undefined) {
        if (first === undefined) this.firstOwner.set(target.id, owner);
        else if (!sameOwner(first, owner)) this.violations.push(`${target.id} changed owner`);
      }
      const recorded = this.firstOwner.get(target.id);
      // Closed pages keep their attribution (tombstones).
      for (const session of this.sessions) {
        const ever = this.dispatcher.everOwnedBy(target.page, session.id);
        const expected = recorded !== undefined && sameOwner(recorded, sessionOwner(session.id));
        if (ever !== expected)
          this.violations.push(`${target.id} tombstone differs for ${session.id}`);
      }
      const holders = this.sessions.filter((s) => s.registry.has(target.page));
      if (holders.length > 1) this.violations.push(`${target.id} is in ${holders.length} views`);
      for (const holder of holders) {
        if (recorded === undefined || !sameOwner(recorded, sessionOwner(holder.id))) {
          this.violations.push(
            `${target.id} is in ${holder.id}'s registry but not attributed to it`,
          );
        }
      }
      if (recorded !== undefined && !sameOwner(recorded, this.expectedOwner(target))) {
        this.violations.push(`${target.id} attributed against the rules`);
      }
    }
  }

  /** The owner spec 13 §3.4 prescribes for a decided target. */
  expectedOwner(target: ModelTarget): PageOwner {
    const origin = target.origin;
    if (origin.kind === 'none') return PARKED;
    if (origin.kind === 'claim')
      return target.claimMissed ? PARKED : sessionOwner(origin.sessionId);
    return this.firstOwner.get(origin.openerId) ?? PARKED;
  }
}

async function runCase(seed: number): Promise<{ violations: string[]; trace: string[] }> {
  const next = rng(seed);
  const model = new HostModel(next);
  // Pages Chromium restored at host start: no session, no opener.
  const restored = Math.floor(next() * 3);
  for (let i = 0; i < restored; i++) {
    model.adopt(model.newTarget(null, { kind: 'none', why: 'restored' }, i));
  }
  for (let step = 0; step < STEPS; step++) {
    const op = model.pick(OPS) ?? 'openView';
    await model.run(op);
    if (model.violations.length > 0) break;
  }
  if (model.violations.length === 0) await model.hostCrash();
  if (model.violations.length === 0) {
    for (const session of model.sessions) {
      if (session.registry.size > 0)
        model.violations.push(`${session.id} kept pages after the crash`);
    }
  }
  return { violations: model.violations, trace: model.trace };
}

describe('page attribution invariant (property)', () => {
  it(
    `holds over ${CASES} random host histories`,
    async () => {
      for (let seed = 1; seed <= CASES; seed++) {
        const { violations, trace } = await runCase(seed);
        if (violations.length > 0) {
          throw new Error(`seed ${seed}: ${violations.join('; ')}\n${trace.join('\n')}`);
        }
      }
    },
    TIMEOUT_MS,
  );

  it(
    'an exclusive host gives every page to its one session',
    async () => {
      const runs = NIGHTLY ? 10_000 : 200;
      for (let seed = 1; seed <= runs; seed++) {
        const next = rng(seed * 7919);
        const model = new HostModel(next, sessionOwner('only'));
        const session = model.openView('only');
        for (let step = 0; step < STEPS; step++) {
          const kind = model.pick(['first', 'popup', 'close', 'operator'] as const) ?? 'first';
          const live = model.livePages();
          const opener = model.pick(live);
          if (kind === 'close' && opener !== undefined) await model.close(opener);
          else if (kind === 'popup' && opener !== undefined) {
            model.adopt(model.newTarget(opener.id, { kind: 'opener', openerId: opener.id }, 0));
          } else model.adopt(model.newTarget(null, { kind: 'none', why: kind }, 0));
        }
        await model.deliverFacts(true);
        for (const target of model.livePages()) {
          expect(model.dispatcher.ownerOf(target.page)).toEqual(sessionOwner('only'));
          expect(session.registry.has(target.page)).toBe(true);
        }
        expect(model.dispatcher.parkedPages()).toEqual([]);
      }
    },
    TIMEOUT_MS,
  );
});
