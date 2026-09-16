/** @module interface/mcp/services — the ToolServices record: narrow structural views of the app services and ports the tools depend on (composition builds it once). */

import type { AttentionOutcome } from '@browserhive/contracts/tools';
import type {
  AttentionCallContext,
  AttentionRequestInput,
} from '../../app/attention/attention-service.ts';
import type {
  SavedAuthEntry,
  SavedAuthResult,
  StorageStateSource,
} from '../../app/auth-states/store.ts';
import type { ToolCheckContext } from '../../app/blocklist/blocklist-service.ts';
import type { DomainEvents } from '../../app/events/catalog.ts';
import type { SessionService } from '../../app/sessions/session-service.ts';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import type { CallerSubject } from '../../domain/vault/bindings.ts';
import type {
  ListAvailableOptions,
  ListAvailableResult,
  VaultFillContext,
  VaultFillRequest,
  VaultFillResult,
} from '../../domain/vault/types.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { PageActions } from '../../ports/page-actions.ts';
import type { RuntimeFacts } from './runtime.ts';

/** The attention surface the two attention tools use (`AttentionService` satisfies it). */
export interface AttentionLike {
  request(
    sessionId: string,
    input: AttentionRequestInput,
    ctx: AttentionCallContext,
  ): Promise<AttentionOutcome>;
  result(requestId: string, ctx: AttentionCallContext): Promise<AttentionOutcome>;
}

/** The vault surface the two vault tools use (`VaultService` satisfies it). */
export interface VaultLike {
  readonly configured: boolean;
  /** @throws `VAULT_NOT_CONFIGURED` */
  assertConfigured(): void;
  fill(request: VaultFillRequest, ctx: VaultFillContext): Promise<VaultFillResult>;
  listAvailable(
    caller: CallerSubject,
    opts?: ListAvailableOptions,
    signal?: AbortSignal,
  ): Promise<ListAvailableResult>;
}

/** The auth-state surface the three auth-state tools use (`AuthStateStore` satisfies it). */
export interface AuthStatesLike {
  saveStorageState(
    source: StorageStateSource,
    name: string,
    sourceSessionId: string,
    principal: SessionPrincipal,
  ): Promise<SavedAuthResult>;
  saveFullProfile(
    userDataDir: string,
    name: string,
    sourceSessionId: string,
    principal: SessionPrincipal,
  ): Promise<SavedAuthResult>;
  saveIdentitySeed(name: string, seed: string): Promise<boolean>;
  list(principal: SessionPrincipal): Promise<SavedAuthEntry[]>;
}

/** The blocklist surface (`BlocklistService` satisfies it). */
export interface BlocklistLike {
  /** @throws `URL_BLOCKED` */
  assertAllowed(url: string, context: ToolCheckContext): void;
}

/** The filesystem slice the file/inspection tools need (production: {@link createNodeToolFs}). */
export interface ToolFs {
  /** Recursive mkdir with mode 0700. */
  mkdir(dir: string): Promise<void>;
  /** Byte size of a file. @throws when missing. */
  fileSize(path: string): Promise<number>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

/**
 * Output redaction for tool results (spec 02 §2.3): composition backs it with the vault redaction
 * windows plus the kernel redactor (registered literals and credential patterns).
 */
export interface ToolRedaction {
  /** Scrubs armed credentials (for `sessionId`, when given) and registered secrets from `text`. */
  scrubText(sessionId: string | null, text: string): string;
  /** Closes a session's redaction window once it navigates off the credential's origins. */
  onNavigation(sessionId: string, url: string): void;
}

/** Everything a tool handler may reach. Built once by the composition root; runtime objects never change. */
export interface ToolServices {
  readonly sessions: SessionService;
  /** `null` when no operator-request broker exists (stdio): both attention tools then refuse. */
  readonly attention: AttentionLike | null;
  readonly vault: VaultLike;
  readonly authStates: AuthStatesLike;
  readonly blocklist: BlocklistLike;
  readonly pageActions: PageActions;
  readonly fs: ToolFs;
  readonly redaction: ToolRedaction;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly runtime: RuntimeFacts;
}
