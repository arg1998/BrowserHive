/** @module app/sessions/pipeline-context — the state threaded through the D-21 creation pipeline, its phase names and runners, the compensator helper, and the template branch's launcher (spec 13 §3.7). */

import type { CreateSessionRequest } from '../../domain/session/create-request.ts';
import type { Session } from '../../domain/session/session.ts';
import type { SessionTemplate } from '../../domain/session/session-template.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  BrowserHost,
  LaunchIdentity,
  ProxySpec,
  SessionView,
} from '../../ports/browser-driver.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplatePageOptions } from '../../ports/template-host.ts';
import type { SessionDirs } from './profile-dir.ts';

/** Mutable state threaded through the phases of one run. */
export interface PipelineContext {
  request?: CreateSessionRequest;
  session?: Session;
  dirs?: SessionDirs;
  storageStatePath?: string;
  restoredSeed: string | null;
  proxy: ProxySpec | null;
  identity?: LaunchIdentity;
  view?: SessionView;
  /** The full host, for `installPolicies` only; the session keeps the view. */
  host?: BrowserHost;
}

/** Registers a compensator that never throws (failures are logged, the unwind continues). */
export function compensate(
  stack: AsyncDisposableStack,
  log: Logger,
  name: string,
  fn: () => Promise<void>,
): void {
  stack.defer(async () => {
    try {
      await fn();
    } catch (err) {
      log.warn('compensator failed', { step: name, err: serializeError(err) });
    }
  });
}

/** One phase: mutates the context, registers its compensator on `stack` before returning. */
export type PhaseRunner = (ctx: PipelineContext) => Promise<void>;

/** Every phase name the runners cover. */
export type PhaseName =
  | 'validate'
  | 'admit'
  | 'reserve'
  | 'prepareProfile'
  | 'resolveIdentity'
  | 'launch'
  | 'installPolicies'
  | 'startTracing'
  | 'applyIdentity'
  | 'register';

/**
 * What a virtual-session launch needs from the template's host supervisor. The pipeline calls
 * `reserve` under the registry lock, `acquire` in `prepareProfile` and `open` in `launch`.
 */
export interface VirtualSessionLauncher {
  readonly template: SessionTemplate;
  /** The template proxy's operator label (`proxy_label`), or `null`. */
  readonly proxyLabel: string | null;
  /**
   * Under the registry lock: when this launch must start the host, `admitSlot` checks a browser
   * slot (throwing `SESSION_LIMIT_REACHED`) and the host is marked `starting` before the lock is
   * released. Returns the compensator that gives an unused reservation back.
   */
  reserve(admitSlot: () => void): () => void;
  /** Starts the host or joins its start, within the remaining budget (spec 13 §3.7 `prepareProfile`). */
  acquire(signal: AbortSignal): Promise<void>;
  /** Opens the session's first window (spec 13 §3.3). */
  open(
    sessionId: string,
    options: { readonly pageOptions: TemplatePageOptions; readonly signal: AbortSignal },
  ): Promise<SessionView>;
}
