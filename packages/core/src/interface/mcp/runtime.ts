/** @module interface/mcp/runtime — RuntimeFacts: the server facts (config + process) the tool layer reads. */

import type { Channel, PersistenceMode } from '@browserhive/contracts/enums';

/** Server facts the tool layer reads (from `ServerConfig` + the process). */
export interface RuntimeFacts {
  readonly version: string;
  readonly transport: 'http' | 'stdio';
  /** Epoch ms the server started (`server_status.uptime_ms`). */
  readonly startedAt: number;
  readonly allowEvaluate: boolean;
  /** `minAttentionWait` in ms (rendered into `request_attention`'s description as seconds). */
  readonly minAttentionWaitMs: number;
  readonly vault: { readonly enabled: boolean; readonly backend: string | null };
  readonly dataDir: string;
  readonly persistenceMode: PersistenceMode;
  /** `defaultChannel` / `defaultHeadless` baked into the `launch_session` schema (spec 02 §4). */
  readonly launchDefaults: { readonly channel: Channel; readonly headless: boolean };
}
