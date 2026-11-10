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
import type { SessionService } from '@browserhive/core/server';
import {
  AttentionService,
  OperatorRequestBroker,
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
export declare function buildOperators(input: OperatorsInput): OperatorsParts;
//# sourceMappingURL=domain-operators.d.ts.map
