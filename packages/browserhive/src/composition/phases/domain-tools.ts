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
  VaultRedaction,
  VaultService,
} from '@browserhive/core/server';
import { createNodeToolFs, createToolRegistry, ToolDispatcher } from '@browserhive/core/server';

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
  readonly pageActions: PageActions;
  readonly redactor: Redactor;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** The runtime facts every MCP server instance and the dispatcher share. */
export function runtimeFactsFor(input: ToolsInput): RuntimeFacts {
  const { config } = input;
  return {
    version: input.version,
    transport: input.transport,
    startedAt: input.startedAt,
    allowEvaluate: config.allowEvaluate,
    minAttentionWaitMs: config.minAttentionWait,
    vault: {
      enabled: input.vaultBackend !== 'off',
      backend: input.vaultBackend === 'off' ? null : input.vaultBackend,
    },
    dataDir: config.dataDir,
    persistenceMode: config.persistence,
    launchDefaults: { channel: config.defaultChannel, headless: config.defaultHeadless },
  };
}

/** Builds the dispatcher (one per process; MCP server instances share it). */
export function buildTools(input: ToolsInput): {
  readonly runtime: RuntimeFacts;
  readonly dispatcher: ToolDispatcher;
} {
  const runtime = runtimeFactsFor(input);
  const { redactor, vaultRedaction } = input;
  const dispatcher = new ToolDispatcher({
    services: {
      sessions: input.sessions,
      attention: input.attention,
      vault: input.vault,
      authStates: input.authStates,
      blocklist: input.blocklist,
      pageActions: input.pageActions,
      fs: createNodeToolFs(),
      redaction: {
        scrubText: (sessionId, text) =>
          redactor.scrubText(sessionId === null ? text : vaultRedaction.scrub(sessionId, text)),
        onNavigation: (sessionId, url) => vaultRedaction.onNavigation(sessionId, url),
      },
      bus: input.bus,
      clock: input.clock,
      ids: input.ids,
      runtime,
    },
    registry: createToolRegistry(runtime),
    logger: input.logger,
  });
  return { runtime, dispatcher };
}
