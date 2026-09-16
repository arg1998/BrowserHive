/** @module contracts/config/rules — cross-field validation rules with the exact texts of spec 08 §4.1 */

import { isLoopbackHost } from './host.ts';
import { formatDuration } from './parsers.ts';
import type { ConfigKey, ServerConfig } from './shape.ts';

/** One cross-field violation. `code` is set for the rules that are documented error codes. */
export interface CrossFieldIssue {
  /** Exact message text. */
  readonly message: string;
  /** The key the issue is attributed to. */
  readonly path: ConfigKey;
  /** Registry code when the rule is a policy guard (`ADMIN_REQUIRES_HTTP`). */
  readonly code?: 'ADMIN_REQUIRES_HTTP';
}

/** Which keys were supplied by a source (not defaulted or derived); the resolver knows, the schema does not. */
export type ExplicitKeys = ReadonlySet<ConfigKey>;

/** Empty explicit set: rules that need provenance are skipped. */
export const NO_EXPLICIT_KEYS: ExplicitKeys = new Set();

const OTEL_DEPENDENT_KEYS = [
  'otelEndpoint',
  'otelProtocol',
  'otelHeaders',
  'otelServiceName',
  'otelSampleRatio',
] as const satisfies readonly ConfigKey[];

/**
 * Evaluate every cross-field rule (spec 08 §4.1 rules 1–10). Rule 11 (`INSECURE_BIND_REFUSED`) is a
 * policy guard the resolver applies with {@link isLoopbackHost}; it is not a validation issue.
 *
 * @returns The violations, in rule order; empty when the configuration is consistent.
 */
export function crossFieldIssues(
  config: ServerConfig,
  explicit: ExplicitKeys = NO_EXPLICIT_KEYS,
): readonly CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  const stealthOn = config.stealth !== 'off';

  if (config.minAttentionWait > 0 && config.minAttentionWait >= config.attentionTimeout) {
    issues.push({
      path: 'minAttentionWait',
      message: `minAttentionWait must be less than attentionTimeout (got minAttentionWait=${formatDuration(config.minAttentionWait)}, attentionTimeout=${formatDuration(config.attentionTimeout)}). Set minAttentionWait=0 to disable the floor.`,
    });
  }
  if (config.humanize && !stealthOn) {
    issues.push({
      path: 'humanize',
      message: `humanize=true requires stealth to be 'standard' or 'max' (got stealth=${config.stealth}).`,
    });
  }
  if (config.fingerprint && !stealthOn && explicit.has('fingerprint')) {
    issues.push({
      path: 'fingerprint',
      message: `fingerprint=true requires stealth to be 'standard' or 'max' (got stealth=${config.stealth}).`,
    });
  }
  if (
    config.captcha === 'attention' &&
    explicit.has('captcha') &&
    !(config.admin && config.transport === 'http')
  ) {
    issues.push({
      path: 'captcha',
      message:
        'captcha=attention requires admin=true and transport=http, because CAPTCHA hand-off needs the dashboard.',
    });
  }
  if (config.admin && config.transport !== 'http') {
    issues.push({
      path: 'admin',
      code: 'ADMIN_REQUIRES_HTTP',
      message: 'admin=true requires transport=http. The dashboard is not available under stdio.',
    });
  }
  if (config.auth === 'token' && config.transport !== 'http') {
    issues.push({
      path: 'auth',
      message:
        'auth=token requires transport=http. Under stdio every caller is the local principal.',
    });
  }
  if (!config.otel) {
    const set = OTEL_DEPENDENT_KEYS.filter((k) => explicit.has(k));
    if (set.length > 0) {
      const names = set.length === 1 ? set[0] : `${set.slice(0, -1).join(', ')} and ${set.at(-1)}`;
      issues.push({
        path: set[0] ?? 'otel',
        message: `${names} require${set.length === 1 ? 's' : ''} otel=true.`,
      });
    }
  }
  if (config.trustedProxies.length > 0 && isLoopbackHost(config.host)) {
    issues.push({
      path: 'trustedProxies',
      message:
        'trustedProxies requires a non-loopback host; on a loopback bind X-Forwarded-For is never trusted.',
    });
  }
  if (config.screenshotTrace && !config.trace) {
    issues.push({ path: 'screenshotTrace', message: 'screenshotTrace=true requires trace=true.' });
  }
  if (config.blocklistWatch && config.blocklist === undefined) {
    issues.push({
      path: 'blocklistWatch',
      message: 'blocklistWatch=true requires blocklist to be set.',
    });
  }
  return issues;
}

/**
 * Rule 11 of spec 08 §4.1: a non-loopback bind without `auth=token` and without `allowInsecureBind`
 * is refused with `INSECURE_BIND_REFUSED` (exit 3).
 *
 * @returns `true` when the resolver must refuse to start.
 */
export function isInsecureBind(config: ServerConfig): boolean {
  return (
    config.transport === 'http' &&
    !isLoopbackHost(config.host) &&
    config.auth !== 'token' &&
    !config.allowInsecureBind
  );
}
