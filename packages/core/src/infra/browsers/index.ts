/** @module infra/browsers — named exports of the Playwright/Patchright browser adapter and the stealth pipeline. */

export {
  type BlockedUrlHit,
  type BlockedUrlObserver,
  type BlocklistRouteDeps,
  installBlocklistRoute,
} from './blocklist-route.ts';
export {
  isChannel,
  type LaunchKwargs,
  launchKwargsForChannel,
  SUPPORTED_CHANNELS,
} from './channel.ts';
export {
  assertChromiumInstalled,
  browserNotInstalled,
  browserNotInstalledFromLaunchError,
  type ChromiumResolverDeps,
  installCommandFor,
  pinnedPlaywrightVersion,
} from './chromium-resolver.ts';
export {
  type ClassifyContext,
  classifyDriverError,
  firstLine,
  isActionabilityError,
  isTargetClosedError,
} from './classify-error.ts';
export {
  DriverResolver,
  type DriverResolverDeps,
  loadPatchrightChromium,
  type PatchrightLoader,
  type ResolvedDriver,
} from './driver-resolver.ts';
export { type Evaluable, evaluateMainWorld } from './evaluate.ts';
export {
  contextOptionsFor,
  DISPLAYS,
  type DisplayFamily,
  deriveFingerprint,
  displayFamilyFor,
  type FingerprintInput,
  FURNITURE,
  scriptPayloadFor,
} from './fingerprint.ts';
export {
  callerGeoSeed,
  countryCodeForLocale,
  FALLBACK_LOCALE,
  FALLBACK_TIMEZONE,
  type HostGeoEnvironment,
  HostGeoSeedResolver,
  isValidTimezone,
  languagesForLocale,
  localeFromPosixEnv,
  resolveHostGeoSeed,
} from './geo-seed.ts';
export type { HostFacts } from './host-facts.ts';
export { type ApplyIdentityInput, IdentityApplier } from './identity-applier.ts';
export {
  type IdentityRequest,
  type IdentityResolverDeps,
  type ResolvedIdentity,
  resolveIdentity,
} from './identity-resolver.ts';
export {
  AUTOMATION_ARG,
  type BuildLaunchOptionsInput,
  type BuiltLaunchOptions,
  buildLaunchOptions,
  executablePathWarning,
  mergeIgnoreDefaultArgs,
  playwrightProxyFor,
  STEALTH_ARGS,
} from './launch-args.ts';
export {
  installNativeGetters,
  mergeNativeGetterPayloads,
  type NativeGetterPayload,
  type ScreenMetrics,
  type WindowMetrics,
} from './native-getter.ts';
export {
  assertLaunchOptionsAllowed,
  BrowserContextOptionsSchema,
  byoProxyPresent,
  extractByoProxy,
  LaunchOptionsSchema,
  type ParsedContextOptions,
  type ParsedLaunchOptions,
  PROXY_ARG_PREFIXES,
  ProxyOptionSchema,
  parseContextOptions,
  parseLaunchOptions,
  proxyLabelFor,
  UNSAFE_LAUNCH_OPTION_FIELDS,
} from './pass-through.ts';
export {
  capabilitiesFor,
  PlaywrightBrowserDriver,
  type PlaywrightBrowserDriverDeps,
} from './playwright-browser-driver.ts';
export { FORCED_PROXY_BYPASS, mergeBypass, PassThroughProxyResolver } from './proxy.ts';
export { PlaywrightSessionHandle, type SessionHandleInput } from './session-handle.ts';
export {
  archFor,
  type CoherentIdentity,
  deriveCoherentIdentity,
  deviceMemoryPayload,
  FALLBACK_PLATFORM_VERSIONS,
  type IdentityInput,
  PRESENTED_DEVICE_MEMORY,
  parseChromeVersion,
  platformVersionFor,
  type UserAgentOverride,
  uaChPlatformFor,
} from './stealth-identity.ts';
export {
  mergeTraceParts,
  PlaywrightTracingHandle,
  TRACE_FINALIZE_TIMEOUT_MS,
  type TracingFs,
  type TracingHandleDeps,
  type TracingLike,
  traceFinalizeWarning,
  traceStartWarning,
} from './tracing.ts';
