/** @module contracts/config/keys-observability — logging, recording, retention and telemetry keys (spec 08 §5.3, spec 10 §4/§8) */
import type { z } from 'zod';
import { LogColor } from '../enums/log-color.ts';
import { LogFormat } from '../enums/log-format.ts';
import { LogPersist } from '../enums/log-persist.ts';
import { OtelProtocol } from '../enums/otel-protocol.ts';
import { OtelSignal } from '../enums/otel-signal.ts';
import { RecordToolResults } from '../enums/record-tool-results.ts';
import { derived, key } from './key.ts';
import {
  zBool,
  zBytes,
  zEnumOf,
  zInt,
  zLevelSpec,
  zList,
  zMap,
  zRatio,
  zString,
  zUrl,
} from './parsers.ts';

const SIXTY_FOUR_MIB = 64 * 1024 * 1024;

const zRetentionBytes = zBytes
  .refine((bytes) => bytes >= SIXTY_FOUR_MIB, { message: "Expected a size of at least '64MiB'." })
  .meta({ grammar: "a size of at least '64MiB'" });

const zSignals = zList
  .refine((items) => items.every((item) => OtelSignal.safeParse(item).success), {
    message: `Expected a comma-separated subset of: ${OtelSignal.options.join(', ')}.`,
  })
  .meta({ grammar: `a comma-separated subset of: ${OtelSignal.options.join(', ')}` });

/** Keys of the `logging` group. */
export const LOGGING_KEYS = {
  logLevel: key(zLevelSpec, {
    default: { root: 'info', modules: {} },
    defaultText: 'info',
    group: 'logging',
    restartRequired: false,
    describe:
      'Log level, optionally per module: info,sessions=debug,http=warn. Levels: error, warn, info, debug, trace.',
    examples: ['info', 'info,sessions=debug'],
  }),
  logFormat: key(zEnumOf(LogFormat.options), {
    default: 'auto',
    group: 'logging',
    restartRequired: false,
    describe: 'Log renderer. auto is pretty on a TTY (http only), otherwise JSON lines.',
  }),
  color: key(zEnumOf(LogColor.options), {
    default: 'auto',
    group: 'logging',
    describe:
      'Colour for logs and CLI output. auto honours NO_COLOR, FORCE_COLOR, TERM=dumb and TTY.',
  }),
  logRingSize: key(zInt(100, 1_000_000), {
    default: 5000,
    group: 'logging',
    describe: 'Records kept in the in-process log ring buffer served to the dashboard.',
  }),
  logPersist: key(zEnumOf(LogPersist.options), {
    default: 'off',
    group: 'logging',
    describe: 'Durable logs table threshold (retention 3 days). off disables the sink.',
  }),
} as const;

/** Keys of the `recording` group. */
export const RECORDING_KEYS = {
  trace: key(zBool, {
    default: derived('admin'),
    group: 'recording',
    describe: 'Record a Playwright trace per session. Defaults to the value of admin.',
  }),
  screenshotTrace: key(zBool, {
    default: false,
    group: 'recording',
    describe: 'Store a JPEG after each tool call. Requires trace=true.',
  }),
  screencastQuality: key(zInt(1, 100), {
    default: 60,
    group: 'recording',
    describe: 'JPEG quality of the live view screencast (1-100).',
  }),
  recordToolResults: key(zEnumOf(RecordToolResults.options), {
    default: 'full',
    group: 'recording',
    describe:
      'What of a tool result is persisted: full text (capped), shape (keys and sizes) or none.',
  }),
  retentionDays: key(zInt(1), {
    default: 7,
    group: 'recording',
    describe:
      'Days to keep events and artifacts. Must be at least 1; use a large number to keep longer.',
  }),
  retentionBytes: key(zRetentionBytes, {
    default: 1024 * 1024 * 1024,
    defaultText: '1GiB',
    group: 'recording',
    describe: 'Disk budget for the database and artifacts before the oldest rows are pruned.',
  }),
  backupsKeep: key(zInt(1), {
    default: 5,
    group: 'recording',
    describe: 'Pre-migration database backups to retain.',
  }),
  urlQueryAllowlist: key(zList, {
    default: [],
    group: 'recording',
    describe:
      'Query parameter names kept when URLs are sanitized for storage; all others are stripped.',
  }),
} as const;

/** Keys of the `telemetry` group (D-08). */
export const TELEMETRY_KEYS = {
  otel: key(zBool, {
    default: false,
    group: 'telemetry',
    describe: 'Export traces, metrics and logs over OTLP/HTTP.',
  }),
  otelEndpoint: key(zUrl, {
    default: 'http://127.0.0.1:4318',
    group: 'telemetry',
    describe: 'OTLP/HTTP base URL; /v1/traces, /v1/metrics and /v1/logs are appended.',
  }),
  otelProtocol: key(zEnumOf(OtelProtocol.options), {
    default: 'http/protobuf',
    group: 'telemetry',
    describe: 'OTLP/HTTP encoding.',
  }),
  otelHeaders: key(zMap, {
    default: {},
    group: 'telemetry',
    secret: true,
    describe: 'Headers sent with every OTLP request, e.g. Authorization=Bearer …',
  }),
  otelServiceName: key(zString, {
    default: 'browserhive',
    group: 'telemetry',
    describe: 'service.name resource attribute.',
  }),
  otelSampleRatio: key(zRatio, {
    default: 1,
    group: 'telemetry',
    describe: 'Parent-based ratio sampler for traces (0-1).',
  }),
  otelSignals: key(zSignals, {
    default: ['traces', 'metrics', 'logs'],
    group: 'telemetry',
    describe: 'Signals to export.',
  }),
  otelVerbose: key(zBool, {
    default: false,
    group: 'telemetry',
    describe: 'Also export db.query and cdp.command spans.',
  }),
  otelTraceUrlTemplate: key(zString, {
    optional: true,
    group: 'telemetry',
    restartRequired: false,
    describe:
      'Dashboard deep-link template for a trace; {trace_id} is substituted. Used only by the dashboard.',
    examples: ['https://grafana.local/explore?traceId={trace_id}'],
  }),
} as const;

/** Output type of the logging keys. */
export type LoggingKeysOutput = z.output<z.ZodObject<typeof LOGGING_KEYS>>;
/** Output type of the recording keys. */
export type RecordingKeysOutput = z.output<z.ZodObject<typeof RECORDING_KEYS>>;
/** Output type of the telemetry keys. */
export type TelemetryKeysOutput = z.output<z.ZodObject<typeof TELEMETRY_KEYS>>;
