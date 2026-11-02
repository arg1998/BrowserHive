/** @module domain/vault/test-support — fakes and a harness shared by the vault unit suites (page, tracing, broker wiring over in-memory repos). */

import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { FakeVaultBackend } from '../../../test/helpers/fake-vault-backend.ts';
import { createVaultRepos } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import {
  type CollectingLogger,
  createCollectingLogger,
} from '../../../test/helpers/test-logger.ts';
import { SecretRegistry } from '../../kernel/redact.ts';
import type { TracingHandle } from '../../ports/browser-driver.ts';
import type {
  VaultBindingRecord,
  VaultGroupPolicyRecord,
} from '../../ports/persistence/records.ts';
import { OperatorRequestBroker } from '../operator-requests/broker.ts';
import type { OperatorRequestEvents } from '../operator-requests/types.ts';
import { mergeBinding, type VaultBindingInput } from './bindings.ts';
import { VaultBroker, type VaultBrokerDeps } from './broker.ts';
import { mergePolicy, type VaultGroupPolicyInput } from './policies.ts';
import { VaultRedaction } from './redaction.ts';
import type { VaultEvents, VaultFillContext, VaultFillSession, VaultPage } from './types.ts';

/** The credential the fake backend returns for the default `linkedin` item. */
export const SECRET = 'S3cr3t-P@ssw0rd-xyz';
/** Its username. */
export const USER = 'alice@example.com';

/** A page that records fill/click calls and reports a configurable url + form action. */
export class FakePage implements VaultPage {
  readonly fills: [string, string][] = [];
  readonly clicks: string[] = [];
  formAction: string | null = null;
  /** When set, `fill` of this selector rejects with it. */
  failFill: { selector: string; error: Error } | null = null;
  /** When set, `click` rejects with it. */
  failClick: Error | null = null;
  private currentUrl: string;

  constructor(url: string) {
    this.currentUrl = url;
  }

  url(): string {
    return this.currentUrl;
  }

  fill(selector: string, value: string): Promise<void> {
    if (this.failFill !== null && this.failFill.selector === selector) {
      return Promise.reject(this.failFill.error);
    }
    this.fills.push([selector, value]);
    return Promise.resolve();
  }

  click(selector: string): Promise<void> {
    if (this.failClick !== null) return Promise.reject(this.failClick);
    this.clicks.push(selector);
    return Promise.resolve();
  }

  waitForTimeout(): Promise<void> {
    return Promise.resolve();
  }

  $eval<T>(_selector: string, fn: (el: unknown) => T): Promise<T> {
    const el: unknown = { form: this.formAction === null ? null : { action: this.formAction } };
    return Promise.resolve(fn(el));
  }
}

/** Records D-13 chunk calls in order; can be told to fail. */
export class FakeTracing implements TracingHandle {
  readonly calls: string[] = [];
  failPause = false;

  pauseChunk(): Promise<void> {
    this.calls.push('pause');
    return this.failPause ? Promise.reject(new Error('pause failed')) : Promise.resolve();
  }

  resumeChunk(): Promise<void> {
    this.calls.push('resume');
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.calls.push('stop');
    return Promise.resolve();
  }
}

/** Everything a vault unit test needs, wired over in-memory repositories. */
export interface VaultHarness {
  readonly clock: FakeClock;
  readonly ids: FakeIdGenerator;
  readonly logger: CollectingLogger;
  readonly registry: SecretRegistry;
  readonly redaction: VaultRedaction;
  readonly backend: FakeVaultBackend;
  readonly repos: ReturnType<typeof createVaultRepos>;
  readonly events: RecordingEventBus<VaultEvents & OperatorRequestEvents>;
  readonly leases: {
    readonly calls: string[];
    pause(id: string, at: number): void;
    resume(id: string, at: number): void;
  };
  readonly confirm: OperatorRequestBroker;
  /** Builds a broker; `withConfirm` (default true) attaches the operator-request broker. */
  broker(overrides?: Partial<VaultBrokerDeps> & { withConfirm?: boolean }): VaultBroker;
  bind(handle: string, input: VaultBindingInput): Promise<VaultBindingRecord>;
  policy(groupId: string | null, input: VaultGroupPolicyInput): Promise<VaultGroupPolicyRecord>;
  /** A fill context for `page`; defaults: `demo-00000001`, slug `linkedin-agent`, principal `local`, evaluate on, vault on. */
  ctx(
    page: VaultPage,
    over?: Partial<VaultFillSession> & { principal?: string; tracing?: TracingHandle | null },
  ): VaultFillContext;
}

/** Builds a {@link VaultHarness}. */
export function createVaultHarness(): VaultHarness {
  const clock = new FakeClock();
  const ids = new FakeIdGenerator();
  const logger = createCollectingLogger({ level: 'trace' });
  const registry = new SecretRegistry({ now: () => clock.now() });
  const redaction = new VaultRedaction({ registry, now: () => clock.now() });
  const backend = new FakeVaultBackend();
  backend.setCredential('i1', { username: USER, password: SECRET });
  backend.setCredential('linkedin', { username: USER, password: SECRET });
  const repos = createVaultRepos();
  const events = new RecordingEventBus<VaultEvents & OperatorRequestEvents>();
  const leases = {
    calls: [] as string[],
    pause(id: string, at: number): void {
      leases.calls.push(`pause:${id}:${at}`);
    },
    resume(id: string, at: number): void {
      leases.calls.push(`resume:${id}:${at}`);
    },
  };
  const confirm = new OperatorRequestBroker({
    requests: repos.requests,
    actions: repos.actions,
    leases,
    events,
    clock,
    ids,
    logger,
  });
  const base: VaultBrokerDeps = {
    backend,
    bindings: repos.bindings,
    policies: repos.policies,
    audit: repos.audit,
    redaction,
    events,
    clock,
    ids,
    logger,
    allowEvaluate: true,
  };
  return {
    clock,
    ids,
    logger,
    registry,
    redaction,
    backend,
    repos,
    events,
    leases,
    confirm,
    broker(overrides = {}) {
      const { withConfirm = true, ...rest } = overrides;
      return new VaultBroker({ ...base, ...(withConfirm && { confirm }), ...rest });
    },
    async bind(handle, input) {
      const prior = await repos.bindings.get(handle);
      const merged = mergeBinding(handle, input, prior, clock.now());
      if (merged === null) throw new Error('bind() needs itemName');
      return repos.bindings.upsert(merged);
    },
    async policy(groupId, input) {
      const key = groupId ?? '__ungrouped__';
      const merged = mergePolicy(groupId, input, await repos.policies.get(key), clock.now());
      return repos.policies.upsert(merged);
    },
    ctx(page, over = {}) {
      const { principal = 'local', tracing = null, ...session } = over;
      return {
        session: {
          sessionId: session.sessionId ?? 'demo-00000001',
          slug: session.slug ?? 'linkedin-agent',
          disableEvaluate: session.disableEvaluate ?? false,
          vaultEnabled: session.vaultEnabled ?? true,
          ...(session.humanize !== undefined && { humanize: session.humanize }),
          harness: session.harness ?? null,
          harnessDeclared: session.harnessDeclared ?? null,
        },
        page,
        tracing,
        principal,
        toolEventId: 'e-00000000000000000000000001',
      };
    },
  };
}

// --- D-48: one table of harness gate cases, run through the broker and the dashboard tester -----

/** What a harness gate case expects: the same from `fill` and from the tester. */
export interface HarnessGateExpectation {
  readonly verdict: 'fill' | 'refused';
  /** The operator-facing reason (`not_authorized`, `harness_not_allowed`), `null` for a fill. */
  readonly reason: 'not_authorized' | 'harness_not_allowed' | null;
  readonly rule?: 'binding' | 'group';
}

/** One case: a binding in folder `f-deploy`, a session subject, the expected verdict. */
export interface HarnessGateCase {
  readonly name: string;
  readonly binding: {
    readonly harnesses: readonly string[] | null;
    readonly principals?: readonly string[];
    readonly slugs?: readonly string[];
  };
  /** The folder policy's list (`null` = no list); the policy stays `manual`. */
  readonly group: readonly string[] | null;
  readonly principal: string;
  readonly slug: string;
  /** Launch harness slug; `null` = none recorded (reads `unknown`). */
  readonly harness: string | null;
  readonly declared: string | null;
  readonly expected: HarnessGateExpectation;
}

/** The handle, item and page every harness gate case uses. */
export const HARNESS_GATE_FIXTURE = {
  handle: 'deploy.aws',
  itemName: 'AWS',
  groupId: 'f-deploy',
  origin: 'console.aws.example',
  pageUrl: 'https://console.aws.example/login',
} as const;

const fill: HarnessGateExpectation = { verdict: 'fill', reason: null };
const notAuthorized: HarnessGateExpectation = { verdict: 'refused', reason: 'not_authorized' };
const byBinding: HarnessGateExpectation = {
  verdict: 'refused',
  reason: 'harness_not_allowed',
  rule: 'binding',
};
const byGroup: HarnessGateExpectation = {
  verdict: 'refused',
  reason: 'harness_not_allowed',
  rule: 'group',
};
const base = { principal: 'local', slug: 'deploy-1' } as const;
const claude = { harness: 'claude-code', declared: null } as const;

/** Shared by `broker.test.ts` and `app/vault/vault-admin.test.ts`: the tester must agree with the broker. */
export const HARNESS_GATE_CASES: readonly HarnessGateCase[] = [
  {
    name: 'no list anywhere',
    binding: { harnesses: null },
    group: null,
    ...base,
    ...claude,
    expected: fill,
  },
  {
    name: 'binding allows the slug',
    binding: { harnesses: ['claude-code'] },
    group: null,
    ...base,
    ...claude,
    expected: fill,
  },
  {
    name: 'binding refuses another slug',
    binding: { harnesses: ['opencode'] },
    group: null,
    ...base,
    ...claude,
    expected: byBinding,
  },
  {
    name: 'folder list covers its binding',
    binding: { harnesses: null },
    group: ['opencode'],
    ...base,
    ...claude,
    expected: byGroup,
  },
  {
    name: 'both lists must allow',
    binding: { harnesses: ['claude-code'] },
    group: ['opencode'],
    ...base,
    ...claude,
    expected: byGroup,
  },
  {
    name: 'binding named first when both refuse',
    binding: { harnesses: ['codex'] },
    group: ['opencode'],
    ...base,
    ...claude,
    expected: byBinding,
  },
  {
    name: 'empty binding list allows nothing',
    binding: { harnesses: [] },
    group: null,
    ...base,
    ...claude,
    expected: byBinding,
  },
  {
    name: 'empty folder list allows nothing',
    binding: { harnesses: null },
    group: [],
    ...base,
    ...claude,
    expected: byGroup,
  },
  {
    name: 'unknown matches an unidentified session',
    binding: { harnesses: ['unknown'] },
    group: null,
    ...base,
    harness: null,
    declared: null,
    expected: fill,
  },
  {
    name: 'unknown does not match an identified one',
    binding: { harnesses: ['unknown'] },
    group: null,
    ...base,
    ...claude,
    expected: byBinding,
  },
  {
    name: 'custom name matches the declared name',
    binding: { harnesses: ['Nightly Scraper'] },
    group: null,
    ...base,
    harness: 'nightly-scraper',
    declared: 'Nightly Scraper',
    expected: fill,
  },
  {
    name: 'custom name is case-sensitive',
    binding: { harnesses: ['Nightly Scraper'] },
    group: null,
    ...base,
    harness: 'nightly-scraper',
    declared: 'nightly scraper',
    expected: byBinding,
  },
  {
    name: 'custom name never matches without a declared name',
    binding: { harnesses: ['Nightly Scraper'] },
    group: null,
    ...base,
    harness: 'nightly-scraper',
    declared: null,
    expected: byBinding,
  },
  {
    name: 'lookalike custom name is not the slug',
    binding: { harnesses: ['Claude-Code'] },
    group: null,
    ...base,
    ...claude,
    expected: byBinding,
  },
  {
    name: 'principal is checked before the harness',
    binding: { harnesses: ['opencode'], principals: ['p-agent'] },
    group: null,
    ...base,
    ...claude,
    principal: 'p-other',
    expected: notAuthorized,
  },
  {
    name: 'slug is checked before the harness',
    binding: { harnesses: ['opencode'], slugs: ['ci-*'] },
    group: null,
    ...base,
    ...claude,
    expected: notAuthorized,
  },
  {
    name: 'principal and slug pass, then the harness decides',
    binding: { harnesses: ['claude-code'], principals: ['p-agent'], slugs: ['deploy-*'] },
    group: null,
    ...base,
    principal: 'p-agent',
    ...claude,
    expected: fill,
  },
];

/** Stores a case's binding (folder `f-deploy`, policy `manual`) and puts its item in the backend. */
export async function seedHarnessCase(h: VaultHarness, c: HarnessGateCase): Promise<void> {
  const fx = HARNESS_GATE_FIXTURE;
  h.backend.entries.push({ id: 'i-aws', name: fx.itemName, groupId: fx.groupId, uris: [] });
  h.backend.credentials.set('i-aws', { username: USER, password: SECRET });
  await h.bind(fx.handle, {
    itemName: fx.itemName,
    itemId: 'i-aws',
    groupId: fx.groupId,
    allowedOrigins: [fx.origin],
    allowAllSessions: c.binding.slugs === undefined,
    authorizedSessionSlugs: c.binding.slugs ?? [],
    authorizedPrincipals: c.binding.principals ?? [],
    harnesses: c.binding.harnesses,
  });
  await h.policy(fx.groupId, { accessMode: 'manual', harnesses: c.group });
}
