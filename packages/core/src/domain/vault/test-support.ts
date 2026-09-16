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
        },
        page,
        tracing,
        principal,
        toolEventId: 'e-00000000000000000000000001',
      };
    },
  };
}
