/** @module composition/adapters/browser-memory — samples the resident memory of each live session's browser process tree every 10 s for `browserhive.browser.rss_bytes` (spec 10 §7). Only started when metrics are exported. */
import type { ProcessTreeReader } from '@browserhive/core/runtime';
import type { EveryFn } from './timers.ts';
/**
 * The sampler key of a host: the session id for an exclusive host, `template <id>` for a template
 * host, whose virtual sessions share its process tree (spec 13 §11.7).
 */
export declare function hostKey(host: {
  readonly kind: 'exclusive' | 'template';
  readonly hostId: string;
}): string;
/** The metric attributes of a sampler key: `session_id`, or `template_id` for a template host. */
export declare function rssAttributes(key: string): Record<string, string>;
/** A live browser host as the sampler sees it (spec 13 §3.13: keyed by host). */
export interface SampledSession {
  /** {@link hostKey}: an exclusive host's session id, or `template <id>`. */
  readonly id: string;
  /** The browser's main pid (cached by the host); absent before launch and in fakes. */
  readonly browserPid?: () => Promise<number | null>;
}
/** Dependencies of {@link startBrowserMemorySampler}. */
export interface BrowserMemorySamplerDeps {
  /** The hosts to sample now (today: one per live exclusive session). */
  readonly sessions: () => Iterable<SampledSession>;
  /** `null` where the platform has no reader (Windows): the sampler then never runs. */
  readonly reader: ProcessTreeReader | null;
  /** Repeating timer (`createTimers().every`). */
  readonly repeat: EveryFn;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}
/** A running sampler. */
export interface BrowserMemorySampler {
  /** RSS bytes per host id from the latest sample (a session id for an exclusive host). */
  latest(): ReadonlyMap<string, number>;
  /** Takes one sample now (the timer calls this). */
  sample(): Promise<void>;
  stop(): void;
}
/** Starts sampling; the first sample is taken at once so the first export has data. */
export declare function startBrowserMemorySampler(
  deps: BrowserMemorySamplerDeps,
): BrowserMemorySampler;
//# sourceMappingURL=browser-memory.d.ts.map
