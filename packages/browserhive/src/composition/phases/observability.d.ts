/** @module composition/phases/observability — phase 2: logger (sinks per transport/TTY), ring buffer, redaction registry, OpenTelemetry and the stdio console guard (spec 10 §4.3, §8). */
import type { BootContext } from '../context.ts';
import type { OutputSinks } from '../types.ts';
import type { PhaseHandle } from '../unwind.ts';
/** Where log lines go and how they look (spec 10 §4.3 table). */
export interface LogRouting {
  readonly format: 'json' | 'pretty';
  readonly stream: 'stdout' | 'stderr';
}
/**
 * Stream discipline: stdio → always stderr (JSON unless `logFormat=pretty`); http → pretty on
 * stdout when stdout is a TTY (or `logFormat=pretty`), JSON on stderr otherwise.
 */
export declare function logRouting(
  transport: 'http' | 'stdio',
  logFormat: 'auto' | 'json' | 'pretty',
  isTty: OutputSinks['isTty'],
): LogRouting;
/** A `LineStream` over one output sink (the logger writes `line\n`; sinks take bare lines). */
export declare function lineStream(write: (line: string) => void): {
  write(chunk: string): void;
};
/** Phase `observability`. */
export declare function observabilityPhase(ctx: BootContext): Promise<PhaseHandle>;
//# sourceMappingURL=observability.d.ts.map
