/** @module domain/vault/types — request/context/result shapes of the vault broker and the entry model. */

import type { VaultAccessEvent } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { TracingHandle } from '../../ports/browser-driver.ts';
import type { AuthorizationRule } from './bindings.ts';

/** The minimal page surface the broker drives (a subset of Playwright's `Page`, for testability). */
export interface VaultPage {
  url(): string;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForTimeout?(ms: number): Promise<void>;
  /**
   * Used for the form-action mutation defence; `fn` runs inside the page against the matched
   * element (typed `unknown`: core has no DOM lib). Absent on fakes without a DOM.
   */
  $eval?<T>(selector: string, fn: (el: unknown) => T): Promise<T>;
}

/** The session facts the broker needs, without importing the concrete session. */
export interface VaultFillSession {
  readonly sessionId: string;
  readonly slug: string;
  readonly disableEvaluate: boolean;
  readonly vaultEnabled: boolean;
  /** Whether this session types with human cadence. */
  readonly humanize?: boolean;
}

/** The `vault_fill` tool input (camelCase). */
export interface VaultFillRequest {
  readonly entryName: string;
  readonly usernameSelector: string;
  readonly passwordSelector: string;
  readonly submitSelector?: string;
  readonly afterSubmitWaitMs?: number;
  /** Wipe the inputs after the fill (and the post-submit wait). Default `false`: values are LEFT in the form. */
  readonly clearAfterFill?: boolean;
  readonly tabId?: string;
}

/** Everything a fill needs from its caller. */
export interface VaultFillContext {
  readonly session: VaultFillSession;
  /** The already-resolved target page (by `tabId`). */
  readonly page: VaultPage;
  /** D-13: credential keystrokes are excluded from the trace chunk. `null` when tracing is off. */
  readonly tracing: TracingHandle | null;
  /** Server-assigned caller principal (D-14 authorization subject). */
  readonly principal: string;
  /** The `vault_fill` tool call's event id, for the audit row and the confirm request. */
  readonly toolEventId?: string | null;
  readonly signal?: AbortSignal;
}

/** `vault_fill` outcome; `reason` carries the code on non-success. */
export interface VaultFillResult {
  readonly status: 'success' | 'origin_mismatch' | 'auth_failed' | 'blocked';
  readonly redacted: true;
  readonly reason?: string;
}

/** A resolved fill target — manual binding or allow-all group item. Never carries a secret. */
export interface ResolvedEntry {
  readonly handle: string;
  readonly itemName: string;
  readonly itemId: string;
  readonly groupId: string | null;
  /** Effective origin allow-list (binding origins or derived from the item's login URIs). */
  readonly origins: readonly string[];
  readonly rule: AuthorizationRule;
  readonly redactUsername: boolean;
  readonly requireNoEvaluate: boolean;
  readonly dashboardConfirm: boolean;
  readonly source: 'manual' | 'allow_all';
}

/** The public view of an available entry (never `dashboard_confirm` nor authorized subjects). */
export interface AvailableEntry {
  readonly entryName: string;
  readonly allowedOrigins: readonly string[];
  readonly redactUsername: boolean;
  readonly requireNoEvaluate: boolean;
}

/** Inputs to `listAvailable` that scope the listing to the session's page. */
export interface ListAvailableOptions {
  /** Ground truth from the browser; omitted → unscoped (internal callers only). */
  readonly currentUrl?: string;
  /** The login domain the agent *claims* to be on (honesty probe, registrable domain only). */
  readonly declaredUrl?: string;
  /** Session id, so a mismatch can be audited. */
  readonly sessionId?: string;
  /** Session slug for the feed event (defaults to the caller's slug). */
  readonly sessionSlug?: string;
  readonly toolEventId?: string | null;
}

/** How a listing was scoped (or refused). */
export type ListScope = 'unscoped' | 'page' | 'no_page' | 'rejected';

/** Result of `listAvailable`. */
export interface ListAvailableResult {
  readonly entries: readonly AvailableEntry[];
  readonly scope: ListScope;
  readonly scopedTo: string | null;
  readonly mismatch?: { readonly declared: string; readonly actual: string | null };
  readonly note?: string;
}

/** Domain events the vault publishes — the WS feed shape `app/events/catalog.ts` carries. */
export type VaultEvents = {
  readonly 'vault.access': z.infer<typeof VaultAccessEvent>;
};
