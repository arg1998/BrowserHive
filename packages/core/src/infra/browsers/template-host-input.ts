/** @module infra/browsers/template-host-input — what the launcher hands a template host (spec 13 §3.1): the persistent context, its target bookkeeping and interception chain, the engine facts, and the watchers the site-pack layer attaches. */

import type { BrowserContext } from 'patchright';
import type {
  EngineCapabilities,
  LaunchWarning,
  SessionBrowserInfo,
} from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplatePageWatcher } from '../../ports/template-host.ts';
import type { InterceptionChain } from './interception-chain.ts';
import type { HostTargets } from './template-targets.ts';

/** What the launcher hands the host. */
export interface TemplateHostInput {
  readonly templateId: string;
  readonly context: BrowserContext;
  readonly targets: HostTargets;
  readonly chain: InterceptionChain;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright';
  readonly browserInfo: SessionBrowserInfo;
  readonly warnings: readonly LaunchWarning[];
  readonly headless: boolean;
  readonly window: { readonly width: number; readonly height: number };
  /** Saved passwords or autofill data were found in the profile before the start (spec 13 §3.1). */
  readonly profileSecrets?: boolean;
  /** The profile directory (a sign-in removal finds origins stored by earlier starts). */
  readonly userDataDir?: string;
  /**
   * BrowserHive's marker cookies (spec 13 §3.8), set at start and re-asserted whenever the host
   * may have lost them (Chrome drops session cookies with its last window, D-78).
   */
  readonly markerCookies?: Parameters<BrowserContext['addCookies']>[0];
  /** The watcher of attributed pages and host responses (spec 13 §9.4, §9.5), read per event. */
  readonly pageWatcher?: () => TemplatePageWatcher | null;
  readonly clock: Clock;
  readonly logger: Logger;
}
