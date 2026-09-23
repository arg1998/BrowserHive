/** @module composition/phases/observability — phase 2: logger (sinks per transport/TTY), ring buffer, redaction registry, OpenTelemetry and the stdio console guard (spec 10 §4.3, §8). */

import { hostname } from 'node:os';
import type { LogSink, Telemetry } from '@browserhive/core/runtime';
import {
  createLogger,
  createOtelLogSink,
  createRedactor,
  createRingBuffer,
  createTelemetry,
  redirectConsoleToLogger,
  resolveColor,
  SecretRegistry,
  secretConfigLiterals,
} from '@browserhive/core/runtime';
import type { BootContext } from '../context.ts';
import type { OutputSinks } from '../types.ts';
import type { PhaseHandle } from '../unwind.ts';
import { logConfigDiagnostics } from './resolve-config.ts';

/** Where log lines go and how they look (spec 10 §4.3 table). */
export interface LogRouting {
  readonly format: 'json' | 'pretty';
  readonly stream: 'stdout' | 'stderr';
}

/**
 * Stream discipline: stdio → always stderr (JSON unless `logFormat=pretty`); http → pretty on
 * stdout when stdout is a TTY (or `logFormat=pretty`), JSON on stderr otherwise.
 */
export function logRouting(
  transport: 'http' | 'stdio',
  logFormat: 'auto' | 'json' | 'pretty',
  isTty: OutputSinks['isTty'],
): LogRouting {
  if (transport === 'stdio') {
    return { format: logFormat === 'pretty' ? 'pretty' : 'json', stream: 'stderr' };
  }
  const format = logFormat === 'auto' ? (isTty.stdout ? 'pretty' : 'json') : logFormat;
  return { format, stream: format === 'pretty' ? 'stdout' : 'stderr' };
}

/** A `LineStream` over one output sink (the logger writes `line\n`; sinks take bare lines). */
export function lineStream(write: (line: string) => void): { write(chunk: string): void } {
  return {
    write(chunk) {
      write(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);
    },
  };
}

/** Phase `observability`. */
export async function observabilityPhase(ctx: BootContext): Promise<PhaseHandle> {
  const { config, input } = ctx;
  const routing = logRouting(ctx.transport, config.logFormat, input.output.isTty);
  const streamIsTty =
    routing.stream === 'stdout' ? input.output.isTty.stdout : input.output.isTty.stderr;
  const color = routing.format === 'pretty' && resolveColor(config.color, input.env, streamIsTty);
  const secrets = new SecretRegistry({ now: () => ctx.clock.now() });
  // Operator-supplied secrets (agent tokens, OTLP headers) are registered at birth, before the
  // first log line, exactly like the ones the server mints (spec 10 §9).
  for (const literal of secretConfigLiterals(config)) secrets.add(literal);
  const redactor = createRedactor(secrets);
  const ring = createRingBuffer(config.logRingSize);

  const telemetry: Telemetry = await createTelemetry({
    enabled: config.otel,
    endpoint: config.otelEndpoint,
    protocol: config.otelProtocol,
    headers: config.otelHeaders,
    serviceName: config.otelServiceName,
    serviceVersion: input.appVersion,
    hostName: hostname(),
    osType: input.host.platform,
    transport: ctx.transport,
    sampleRatio: config.otelSampleRatio,
    signals: {
      traces: config.otelSignals.includes('traces'),
      metrics: config.otelSignals.includes('metrics'),
      logs: config.otelSignals.includes('logs'),
    },
    onDegraded: (event) => {
      const code = 'OTEL_EXPORT_FAILED';
      if (event.recovered) ctx.relay.recovered(code);
      else
        ctx.relay.report({
          code,
          severity: 'warn',
          message: `OpenTelemetry ${event.signal} export failing`,
          details: { signal: event.signal },
        });
    },
  });

  const sinks: LogSink[] = [];
  if (telemetry.enabled && config.otelSignals.includes('logs')) {
    sinks.push(createOtelLogSink(telemetry.logsBridge));
  }
  if (input.logSink !== undefined) sinks.push(input.logSink);

  const write = routing.stream === 'stdout' ? input.output.stdout : input.output.stderr;
  const logger = createLogger({
    level: { default: config.logLevel.root, modules: config.logLevel.modules },
    format: routing.format,
    clock: ctx.clock,
    stream: lineStream(write),
    color,
    ringBuffer: ring,
    redactor,
    sinks,
    urlQueryAllowlist: config.urlQueryAllowlist,
    bindings: { transport: ctx.transport },
    traceLeavesRing: config.otelVerbose,
    onSinkDisabled: (failure) =>
      ctx.relay.report({
        code: 'LOG_SINK_DISABLED',
        severity: 'warn',
        message: `log sink ${failure.sink} disabled after repeated failures`,
        details: { sink: failure.sink },
      }),
  });

  // Under stdio stdout is the MCP byte stream: every console call goes to the logger (stderr).
  const restoreConsole = ctx.transport === 'stdio' ? redirectConsoleToLogger(logger) : null;

  ctx.observability = {
    logger,
    ring,
    secrets,
    redactor,
    telemetry,
    format: routing.format,
    color,
  };
  logConfigDiagnostics(logger, input.resolved);

  return {
    async stop() {
      await logger.flush();
      await telemetry.shutdown();
      restoreConsole?.();
    },
  };
}
