/** @module kernel — named exports of the leaf layer (L0): errors, result, context, deadlines, redaction, URL/glob/slug/path helpers. */

export { type FormatBytesOptions, formatBytes } from './bytes.ts';
export {
  bindRequestContext,
  currentRequestContext,
  extendRequestContext,
  type RequestContext,
  type RequestContextPatch,
  type RequestTransport,
  runWithRequestContext,
} from './context.ts';
export {
  anySignal,
  type Deadline,
  DeadlineExceeded,
  isDeadlineExceeded,
  raceSignal,
  timeoutError,
  withDeadline,
} from './deadline.ts';
export {
  assertLaunchArgsAllowed,
  classifyLaunchArgs,
  DENIED_LAUNCH_ARG_KEYS,
  isDeniedLaunchArg,
  launchArgKey,
  type UnsafeLaunchArgDetails,
} from './deny-list.ts';
export { type FormatDurationOptions, formatDuration } from './duration.ts';
export {
  AppError,
  type AppErrorOptions,
  assertNever,
  errorFrom,
  expect,
  isAppError,
  MAX_CAUSE_DEPTH,
  type SerializedError,
  type SerializeErrorOptions,
  serializeError,
} from './errors/index.ts';
export { globToRegExp, hasGlobWildcard, MAX_PATTERN_LENGTH, matchesGlob } from './glob.ts';
export {
  isSafeZipEntry,
  isWithin,
  pathNotAllowed,
  type RealpathFn,
  type ResolveWithinRootsOptions,
  realpathAllowingMissing,
  resolveWithinRoots,
  resolveZipEntry,
} from './paths.ts';
export {
  CIRCULAR,
  createRedactor,
  isSensitiveKey,
  MIN_SECRET_LENGTH,
  REDACTED,
  type Redactor,
  redactKeys,
  SECRET_VALUE_PATTERNS,
  SENSITIVE_KEY_PATTERNS,
  SecretRegistry,
  type SecretRegistryOptions,
  scrubPatterns,
  TRUNCATED,
} from './redact.ts';
export { type Err, err, type Ok, ok, type Result } from './result.ts';
export { isSecret, SECRET_PLACEHOLDER, Secret, secret, unwrapSecret } from './secret.ts';
export {
  assertValidSlug,
  FALLBACK_SLUG,
  ID_ALPHABET,
  ID_SUFFIX_LENGTH,
  type InvalidSlugDetails,
  isValidSlug,
  parseSessionId,
  parseSlug,
  SESSION_ID_RE,
  type SessionIdComponents,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  SLUG_RE,
  sanitizeSlug,
} from './slug.ts';
export {
  classifyUrl,
  INVALID_URL,
  isInsecureBind,
  isIpLiteral,
  isLoopbackHost,
  isPrivateNetworkHost,
  NETWORK_SCHEMES,
  normalizeHost,
  type SanitizeUrlOptions,
  sanitizeUrl,
  URL_CATEGORIES,
  type UrlCategory,
  type UrlClassification,
} from './url.ts';
