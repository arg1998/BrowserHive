/** @module composition/phases/domain-tools — MCP runtime facts, tool registry, `ToolServices` and the shared `ToolDispatcher` (spec 02 §2). */
import type { ServerConfig } from '@browserhive/contracts/config';
import type {
  Clock,
  DomainEvents,
  EventBus,
  IdGenerator,
  Logger,
  Redactor,
} from '@browserhive/core/runtime';
import type {
  AttentionService,
  AuthStateStore,
  BlocklistService,
  PageActions,
  RuntimeFacts,
  SessionService,
  TemplateService,
  VaultRedaction,
  VaultService,
} from '@browserhive/core/server';
import { ToolDispatcher } from '@browserhive/core/server';
/** Inputs of {@link buildTools}. */
export interface ToolsInput {
  readonly config: Readonly<ServerConfig>;
  readonly transport: 'http' | 'stdio';
  readonly version: string;
  readonly startedAt: number;
  readonly sessions: SessionService;
  readonly attention: AttentionService | null;
  readonly vault: VaultService;
  readonly vaultBackend: 'off' | 'bitwarden';
  readonly vaultRedaction: VaultRedaction;
  readonly authStates: AuthStateStore;
  readonly blocklist: BlocklistService;
  readonly templates: TemplateService;
  readonly pageActions: PageActions;
  readonly redactor: Redactor;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}
/** The runtime facts every MCP server instance and the dispatcher share. */
export declare function runtimeFactsFor(input: ToolsInput): RuntimeFacts;
/** Builds the dispatcher (one per process; MCP server instances share it). */
export declare function buildTools(input: ToolsInput): {
  readonly runtime: RuntimeFacts;
  readonly dispatcher: ToolDispatcher;
};
//# sourceMappingURL=domain-tools.d.ts.map
