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
 * adoption, or late enough to need the hold; a claimed target may even name an opener of another
 * session), sites open popups (`window.open`, `noopener`, `target=_blank` from a popup window, an
 * opener that closes before its child is adopted), the operator and service workers open pages in
 * agent windows, pages are restored at start, tabs close (also before their target facts are
 * read), renderer crashes close pages of several sessions at once, listeners call back into the
 * dispatcher, time passes and the host crashes.
 *
 * The expected owner of every page is computed from the model alone (who claimed it and whether
 * the claim landed in time, walked up the opener chain), never from the dispatcher's own output.
 * After every step the suite checks the invariant of spec 13 §3.4:
 *
 * - a page is in at most one session's registry, only in its owner's, and is delivered once;
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
/** 1 000 cases take well under a second; the nightly run needs well over Bun's 5 s default. */
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
  /** A claim that was refused or never landed (its hold expired, or its session closed first). */
  claimMissed: boolean;
  /** Its target facts reached the dispatcher (sync, or a slow answer delivered). */
  factsIn: boolean;
  /** When its facts reached the dispatcher (its hold, if any, starts then). */
  placedAt: number | null;
  /** When it was fed to the dispatcher (its facts deadline starts then). */
  adoptedAt: number | null;
  /** Its slow facts missed the deadline: the dispatcher parks it with no known opener. */
  timedOut: boolean;
}

interface ModelSession {
  readonly id: string;
  readonly registry: Set<Page>;
  readonly deliveries: Map<Page, number>;
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
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** The fake host: real dispatcher, model sessions with tab registries, and the expected owners. */
class HostModel {
  readonly clock = new FakeClock();
  readonly facts = new Map<Page, TargetFacts>();
  readonly dispatcher: HostPageDispatcher;
  readonly targets: ModelTarget[] = [];
  readonly byId = new Map<string, ModelTarget>();
  readonly byPage = new Map<Page, ModelTarget>();
  readonly sessions: ModelSession[] = [];
  readonly pending: PendingCreate[] = [];
  /** `Target.getTargetInfo` answers not yet delivered (a template host reads facts over CDP). */
  readonly slowFacts: Array<{ readonly target: ModelTarget; readonly deliver: () => void }> = [];
  /** First attribution observed per target id (kept after close). */
  readonly firstOwner = new Map<string, PageOwner>();
  /** Refused claims whose targets the model must close after the current step. */
  readonly toClose: ModelTarget[] = [];
  readonly violations: string[] = [];
  readonly trace: string[] = [];
  private nextTarget = 0;
  private nextWindow = 0;

  constructor(
    private readonly next: () => number,
    options: { readonly fallback?: PageOwner; readonly factsReader?: boolean } = {},
  ) {
    this.dispatcher = new HostPageDispatcher({
      fallback: options.fallback ?? PARKED,
      ...(options.factsReader !== false && {
        factsOf: (page: Page) => this.readFacts(page),
      }),
      clock: this.clock,
      logger: createCollectingLogger(),
    });
  }

  private readFacts(page: Page): TargetFacts | Promise<TargetFacts> {
    const facts = this.facts.get(page);
    const target = this.byPage.get(page);
    if (facts === undefined || target === undefined) throw new Error('page without facts');
    if (this.next() >= 0.25) {
      target.factsIn = true;
      target.placedAt = this.clock.now();
      return facts;
    }
    return new Promise<TargetFacts>((resolve) => {
      this.slowFacts.push({
        target,
        deliver: () => {
          target.factsIn = true;
          target.placedAt = this.clock.now();
          resolve(facts);
        },
      });
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
      factsIn: false,
      placedAt: null,
      adoptedAt: null,
      timedOut: false,
    };
    this.facts.set(target.page, { targetId: id, openerId });
    this.targets.push(target);
    this.byId.set(id, target);
    this.byPage.set(target.page, target);
    return target;
  }

  adopt(target: ModelTarget): void {
    target.adoptedAt = this.clock.now();
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
      this.trace.push(`factsArrive ${entry.target.id}`);
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
      deliveries: new Map(),
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
      const count = (session.deliveries.get(page) ?? 0) + 1;
      session.deliveries.set(page, count);
      if (count > 1) this.violations.push(`page delivered to ${session.id} ${count} times`);
      session.registry.add(page);
      // What `TabRegistry.add` does: a closed page leaves the registry on its own.
      page.once('close', () => session.registry.delete(page));
      // A listener that calls back into the dispatcher: it answers a pending window at once.
      if (this.next() < 0.2) {
        const entry = this.pick(this.pending);
        if (entry !== undefined) this.resolve(entry, 'reentrant');
      }
    });
    return session;
  }

  /** `Target.createTarget {background: true}` for `session`, in one of three timings. */
  createWindow(session: ModelSession): void {
    const window = this.nextWindow++;
    session.windows.push(window);
    const timing = this.pick(['claimFirst', 'adoptFirst', 'deferred'] as const) ?? 'claimFirst';
    // A claim made before adoption must win even when the target names an opener (another
    // session's page, a parked one).
    const opener =
      timing === 'claimFirst' && this.next() < 0.3 ? this.pick(this.livePages()) : undefined;
    const target = this.newTarget(
      opener?.id ?? null,
      { kind: 'claim', sessionId: session.id },
      window,
    );
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
    if (!this.dispatcher.claim(target.id, sessionOwner(sessionId))) {
      target.claimMissed = true;
      if (!target.fake.isClosed()) this.toClose.push(target);
    }
    this.observe();
  }

  /** The `createTarget` response for a pending window arrives. */
  resolve(entry: PendingCreate, why: string): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.trace.push(`${why} ${entry.target.id}`);
    const session = this.sessions.find((s) => s.id === entry.sessionId);
    if (session?.open === true) this.claim(entry.target, entry.sessionId);
    else entry.target.claimMissed = true;
    entry.settle();
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
        break;
      }
      case 'newTabViaClaim': {
        const session = this.pick(this.openSessions());
        if (session !== undefined) this.createWindow(session);
        break;
      }
      case 'resolvePending': {
        const entry = this.pick(this.pending);
        if (entry !== undefined) this.resolve(entry, 'resolvePending');
        break;
      }
      case 'windowOpen':
      case 'noopenerPopup': {
        // CDP sets `openerId` for `noopener` popups too; both reach the dispatcher the same way.
        const opener = this.pick(this.livePages());
        if (opener !== undefined) await this.popup(opener, op);
        break;
      }
      case 'blankFromPopup': {
        const opener = this.pick(this.livePages().filter((t) => t.origin.kind === 'opener'));
        if (opener !== undefined) await this.popup(opener, op);
        break;
      }
      case 'openerClosesFirst': {
        // `window.open(url); window.close()`: the opener is gone before its child is adopted.
        const opener = this.pick(this.livePages());
        if (opener === undefined) break;
        const window = this.pick(this.sessions.flatMap((s) => s.windows)) ?? opener.window;
        const target = this.newTarget(opener.id, { kind: 'opener', openerId: opener.id }, window);
        this.trace.push(`openerClosesFirst ${opener.id} -> ${target.id}`);
        await this.close(opener);
        this.adopt(target);
        break;
      }
      case 'serviceWorkerWindow': {
        const target = this.newTarget(
          null,
          { kind: 'none', why: 'service worker' },
          this.nextWindow++,
        );
        this.trace.push(`serviceWorkerWindow ${target.id}`);
        this.adopt(target);
        break;
      }
      case 'operatorCtrlT': {
        // A tab the operator opens by hand inside an agent's window is still parked.
        const window = this.pick(this.sessions.flatMap((s) => s.windows)) ?? this.nextWindow++;
        const target = this.newTarget(null, { kind: 'none', why: 'operator tab' }, window);
        this.trace.push(`operatorCtrlT ${target.id} in window ${window}`);
        this.adopt(target);
        break;
      }
      case 'closeTab': {
        // Any live page, including one whose facts are still being read.
        const target = this.pick(this.livePages());
        if (target === undefined) break;
        this.trace.push(`closeTab ${target.id}`);
        await this.close(target);
        break;
      }
      case 'closeView': {
        const session = this.pick(this.openSessions());
        if (session === undefined) break;
        this.trace.push(`closeView ${session.id}`);
        for (const page of this.dispatcher.pagesOf(session.id)) {
          const target = this.byPage.get(page);
          if (target !== undefined && !target.fake.isClosed()) await this.close(target);
        }
        session.open = false;
        // Its claims go with it (spec 13 §3.5): a window not yet decided is parked.
        for (const target of this.targets) {
          const origin = target.origin;
          if (origin.kind !== 'claim' || origin.sessionId !== session.id) continue;
          const waiting = this.pending.some((p) => p.target === target);
          if (waiting || !target.factsIn) target.claimMissed = true;
        }
        this.dispatcher.releaseSession(session.id);
        this.observe();
        break;
      }
      case 'rendererCrash': {
        // Same-site pages share a renderer: one crash can close pages of several sessions.
        const victims = this.livePages().filter(() => this.next() < 0.4);
        this.trace.push(`rendererCrash ${victims.map((t) => t.id).join(',')}`);
        for (const target of victims) await this.close(target);
        break;
      }
      case 'advanceTime': {
        // Half a hold or a whole one, so holds of different pages expire at different steps. Slow
        // facts may span a half step; before a whole one every answer is in, and an answer still
        // missing at its deadline is dropped (the dispatcher parks that page).
        const step = this.next() < 0.5 ? ATTRIBUTION_HOLD_MS / 2 : ATTRIBUTION_HOLD_MS;
        if (step === ATTRIBUTION_HOLD_MS) await this.deliverFacts(true);
        else {
          for (const entry of [...this.slowFacts]) {
            if (this.next() < 0.5) continue;
            this.slowFacts.splice(this.slowFacts.indexOf(entry), 1);
            this.trace.push(`factsArrive ${entry.target.id}`);
            entry.deliver();
            await flush();
            this.observe();
          }
        }
        this.trace.push(`advanceTime ${step}`);
        const now = this.clock.now() + step;
        for (const entry of [...this.slowFacts]) {
          const adoptedAt = entry.target.adoptedAt;
          if (adoptedAt === null || adoptedAt + ATTRIBUTION_HOLD_MS > now) continue;
          this.slowFacts.splice(this.slowFacts.indexOf(entry), 1);
          entry.target.timedOut = true;
          this.trace.push(`factsTimedOut ${entry.target.id}`);
        }
        // A window whose `createTarget` has not answered is parked once its hold expires, and its
        // late claim is refused.
        for (const entry of this.pending) {
          const placedAt = entry.target.placedAt;
          if (placedAt !== null && placedAt + ATTRIBUTION_HOLD_MS <= now) {
            entry.target.claimMissed = true;
          }
        }
        await this.clock.advance(step);
        await flush();
        this.observe();
        break;
      }
      case 'factsArrive': {
        await this.deliverFacts(false);
        break;
      }
    }
    // A refused claim closes the target (the launch fails, spec 13 §3.3).
    for (const target of this.toClose.splice(0)) {
      if (!target.fake.isClosed()) await this.close(target);
    }
  }

  /** The host browser exits: every page closes at once. */
  async hostCrash(): Promise<void> {
    await this.deliverFacts(true);
    this.trace.push('hostCrash');
    for (const target of this.livePages()) await this.close(target);
    for (const entry of this.pending.splice(0)) {
      entry.target.claimMissed = true;
      entry.settle();
    }
    this.observe();
  }

  /** Records first attributions and checks the invariant at this instant. */
  observe(): void {
    for (const target of this.targets) {
      const actual = this.dispatcher.attributionOf(target.page);
      const first = this.firstOwner.get(target.id);
      if (actual !== undefined) {
        if (first === undefined) this.firstOwner.set(target.id, actual);
        else if (!sameOwner(first, actual)) this.violations.push(`${target.id} changed owner`);
        if (!sameOwner(actual, this.expectedOwner(target))) {
          this.violations.push(`${target.id} attributed against the rules`);
        }
      } else if (first !== undefined) {
        this.violations.push(`${target.id} lost its attribution`);
      }
      const open = this.dispatcher.ownerOf(target.page);
      if (open !== undefined && target.fake.isClosed()) {
        this.violations.push(`${target.id} closed but still open in the dispatcher`);
      }
      const holders = this.sessions.filter((s) => s.registry.has(target.page));
      if (holders.length > 1) this.violations.push(`${target.id} is in ${holders.length} views`);
      for (const holder of holders) {
        if (actual === undefined || !sameOwner(actual, sessionOwner(holder.id))) {
          this.violations.push(
            `${target.id} is in ${holder.id}'s registry but not attributed to it`,
          );
        }
      }
    }
  }

  /** The owner spec 13 §3.4 prescribes, from the model's own record (never the dispatcher's). */
  expectedOwner(target: ModelTarget): PageOwner {
    if (target.timedOut) return PARKED;
    const origin = target.origin;
    if (origin.kind === 'none') return PARKED;
    if (origin.kind === 'claim' && !target.claimMissed) return sessionOwner(origin.sessionId);
    // A missed claim leaves the opener rule, if the target names an opener.
    const openerId =
      origin.kind === 'opener' ? origin.openerId : (this.facts.get(target.page)?.openerId ?? null);
    const opener = openerId === null ? undefined : this.byId.get(openerId);
    return opener === undefined ? PARKED : this.expectedOwner(opener);
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
    // Every hold, held or following an opener, ends within two holds.
    await model.clock.advance(2 * ATTRIBUTION_HOLD_MS);
    await flush();
    model.observe();
    for (const target of model.targets) {
      if (model.dispatcher.attributionOf(target.page) === undefined) {
        model.violations.push(`${target.id} never decided`);
      }
    }
    for (const session of model.sessions) {
      if (session.registry.size > 0) {
        model.violations.push(`${session.id} kept pages after the crash`);
      }
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

  for (const factsReader of [false, true]) {
    const label = factsReader ? 'with' : 'without';
    it(
      `an exclusive host gives every page to its one session (${label} a facts reader)`,
      async () => {
        const runs = NIGHTLY ? 10_000 : 200;
        for (let seed = 1; seed <= runs; seed++) {
          const next = rng(seed * 7919);
          const model = new HostModel(next, { fallback: sessionOwner('only'), factsReader });
          const session = model.openView('only');
          for (let step = 0; step < STEPS; step++) {
            const kind = model.pick(['first', 'popup', 'close', 'operator'] as const) ?? 'first';
            const opener = model.pick(model.livePages());
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
  }
});
