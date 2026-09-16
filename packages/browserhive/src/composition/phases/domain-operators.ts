/** @module composition/phases/domain-operators — operator-request broker, attention (http only), vault backend (`off` | `bitwarden`) + redaction + broker + service (D-14, D-15). */

import type { ServerConfig } from '@browserhive/contracts/config';
import type {
  Clock,
  DomainEvents,
  EventBus,
  HostEnvironment,
  IdGenerator,
  Logger,
  Repositories,
  SecretRegistry,
} from '@browserhive/core/runtime';
import { createBunProcessRunner } from '@browserhive/core/runtime';
import type { SessionService } from '@browserhive/core/server';
import {
  AttentionService,
  BitwardenBackend,
  createVaultHumanTyper,
  OffVaultBackend,
  OperatorRequestBroker,
  VaultBroker,
  VaultRedaction,
  VaultService,
} from '@browserhive/core/server';

/** Inputs of {@link buildOperators}. */
export interface OperatorsInput {
  readonly config: Readonly<ServerConfig>;
  readonly transport: 'http' | 'stdio';
  readonly host: HostEnvironment;
  readonly repos: Repositories;
  readonly sessions: SessionService;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly secrets: SecretRegistry;
}

/** Built operator-facing services. */
export interface OperatorsParts {
  readonly broker: OperatorRequestBroker;
  readonly attention: AttentionService | null;
  readonly vault: VaultService;
  readonly vaultRedaction: VaultRedaction;
  readonly vaultBackend: 'off' | 'bitwarden';
}

/** Builds the broker, attention and vault. */
export function buildOperators(input: OperatorsInput): OperatorsParts {
  const { config, repos, bus, clock, ids, logger } = input;
  const http = input.transport === 'http';
  const broker = new OperatorRequestBroker({
    requests: repos.operatorRequests,
    actions: repos.operatorActions,
    leases: input.sessions.lease,
    events: bus,
    clock,
    ids,
    logger,
  });
  const attention = http
    ? new AttentionService({
        broker,
        clock,
        logger,
        config: {
          transport: 'http',
          attentionTimeoutMs: config.attentionTimeout,
          minAttentionWaitMs: config.minAttentionWait,
        },
      })
    : null;
  const vaultRedaction = new VaultRedaction({ registry: input.secrets, now: () => clock.now() });
  const backend =
    config.vault === 'bitwarden'
      ? new BitwardenBackend({ runner: createBunProcessRunner(), host: input.host, clock, logger })
      : new OffVaultBackend();
  const vaultBroker =
    config.vault === 'off'
      ? null
      : new VaultBroker({
          backend,
          bindings: repos.vaultBindings,
          policies: repos.vaultGroupPolicies,
          audit: repos.vaultAudit,
          redaction: vaultRedaction,
          events: bus,
          clock,
          ids,
          logger,
          allowEvaluate: config.allowEvaluate,
          // D-15: a vault confirmation nobody answers is denied (`confirm_timeout`) after the same
          // deadline as an attention request, instead of holding the fill forever.
          confirmTimeoutMs: config.attentionTimeout,
          ...(http && { confirm: broker }),
          typer: createVaultHumanTyper({ sleep: (ms) => clock.sleep(ms) }),
        });
  const vault = new VaultService({
    backend,
    broker: vaultBroker,
    bindings: repos.vaultBindings,
    policies: repos.vaultGroupPolicies,
    audit: repos.vaultAudit,
    confirm: http ? broker : null,
    clock,
    logger,
  });
  return { broker, attention, vault, vaultRedaction, vaultBackend: config.vault };
}
