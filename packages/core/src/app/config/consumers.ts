/** @module app/config/consumers — the static consumer list asserted against the key registry so a dead key cannot ship (spec 08 §5 consumer column, §6 test plan) */
import type { ConfigKey } from '@browserhive/contracts/config';

/**
 * Module that reads each key. A key without a consumer is dead: it parses but has
 * no effect (`defaultHeadless`, `defaultChannel`, `allowEvaluate` and `captcha=solver` are
 * the keys most at risk, since their effect lives outside the resolver). Update the name here
 * when a consumer moves; the test in `consumers.test.ts` keeps this
 * record complete against `CONFIG_KEYS`.
 */
export const CONSUMED_KEYS: Readonly<Record<ConfigKey, string>> = {
  config: 'app/config/resolve',
  transport: 'browserhive/composition',
  host: 'interface/http/server',
  port: 'interface/http/server',
  auth: 'app/auth/chain',
  authTokens: 'app/auth/token-provider',
  allowInsecureBind: 'app/config/resolve',
  trustedProxies: 'interface/http/middleware/forwarded',
  admin: 'browserhive/composition',
  dataDir: 'browserhive/composition/phases/open-storage',
  shutdownTimeout: 'browserhive/composition',
  sessionCloseTimeout: 'app/sessions/session-service',
  persistence: 'app/sessions/session-service',
  defaultHeadless: 'app/sessions/session-service',
  defaultChannel: 'app/sessions/session-service',
  maxSessions: 'domain/session/admission',
  sessionLease: 'app/sessions/session-service',
  attentionTimeout: 'domain/operator-requests/broker',
  minAttentionWait: 'interface/mcp/tools/attention',
  allowEvaluate: 'interface/mcp/policies',
  blocklist: 'app/blocklist/blocklist-service',
  blocklistWatch: 'app/blocklist/blocklist-service',
  vault: 'app/vault/vault-subsystem',
  stealth: 'infra/browsers/launcher',
  stealthDriver: 'infra/browsers/chromium-resolver',
  fingerprint: 'infra/browsers/launcher',
  humanize: 'infra/browsers/humanize',
  captcha: 'app/system/runtime-info',
  logLevel: 'infra/logging/logger',
  logFormat: 'infra/logging/logger',
  color: 'infra/logging/color',
  logRingSize: 'infra/logging/ring-buffer',
  logPersist: 'app/observability/log-persist-sink',
  trace: 'app/sessions/session-service',
  screenshotTrace: 'app/sessions/session-service',
  screencastQuality: 'interface/ws/screencast',
  recordToolResults: 'app/observability/recorder',
  retentionDays: 'app/maintenance/retention-scheduler',
  retentionBytes: 'app/maintenance/retention-scheduler',
  backupsKeep: 'infra/persistence/migrations/runner',
  urlQueryAllowlist: 'app/observability/recorder',
  otel: 'infra/telemetry/sdk',
  otelEndpoint: 'infra/telemetry/sdk',
  otelProtocol: 'infra/telemetry/sdk',
  otelHeaders: 'infra/telemetry/sdk',
  otelServiceName: 'infra/telemetry/sdk',
  otelSampleRatio: 'infra/telemetry/sdk',
  otelSignals: 'infra/telemetry/sdk',
  otelVerbose: 'infra/telemetry/sdk',
  otelTraceUrlTemplate: 'interface/http/routes/system',
};
