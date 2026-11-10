/** @module infra/browsers — named exports of the Playwright/Patchright browser adapter and the stealth pipeline. */

export {
  type BlockedUrlHit,
  type BlockedUrlObserver,
  type BlocklistRouteDeps,
  blocklistHandler,
  blocklistRouteFailed,
  installBlocklistRoute,
} from './blocklist-route.ts';
export {
  type BrowserDetectionDeps,
  type BrowserSource,
  CHANNEL_LABEL,
  type CommandOutput,
  channelExecutable,
  type DetectedBrowser,
  detectBrowsers,
  type ManagedPolicies,
  managedPolicies,
  parseBrowserVersion,
  parseRegQuery,
  playwrightChannelExecutable,
  playwrightExecutable,
} from './browser-detection.ts';
export { type BrowserHostInput, PlaywrightBrowserHost } from './browser-host.ts';
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
  fixedOwner,
  HANDLER_ORDER,
  InterceptionChain,
  type InterceptionChainDeps,
  type InterceptionContext,
  type InterceptionDisposer,
  type InterceptionHandler,
  type InterceptionHandlerId,
  type InterceptionVerdict,
  type OwnerResolver,
  PASS,
} from './interception-chain.ts';
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
  type AttributionDecision,
  type AttributionRule,
  PARKED,
  PageAttribution,
  type PageAttributionOptions,
  type PageOwner,
  sameOwner,
  sessionOwner,
  type TargetFacts,
  TOMBSTONE_LIMIT,
} from './page-attribution.ts';
export {
  ATTRIBUTION_HOLD_MS,
  HostPageDispatcher,
  type HostPageDispatcherOptions,
  type TargetFactsReader,
} from './page-dispatcher.ts';
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
  ASK_OPERATOR_GUIDANCE,
  capabilitiesFor,
  PlaywrightBrowserDriver,
  type PlaywrightBrowserDriverDeps,
} from './playwright-browser-driver.ts';
export { FORCED_PROXY_BYPASS, mergeBypass, PassThroughProxyResolver } from './proxy.ts';
export { type RequestGuardHandlerDeps, requestGuardHandler } from './request-guard-route.ts';
export {
  APPARMOR_DIR,
  APPARMOR_PROFILE_NAME,
  apparmorProfile,
  apparmorProfileCovers,
  inspectSandboxEnvironment,
  isSandboxFailure,
  probeSandbox,
  SANDBOX_PROBE_TIMEOUT_MS,
  type SandboxEnvironment,
  type SandboxEnvironmentDeps,
  type SandboxProbeResult,
  type SandboxProbeTarget,
  sandboxFailureReason,
} from './sandbox.ts';
export { type SandboxUnavailableInput, sandboxUnavailable } from './sandbox-error.ts';
export {
  type GuidanceAlternative,
  type GuidanceOption,
  type GuidanceTarget,
  renderSandboxGuidance,
  type SandboxGuidance,
  type SandboxGuidanceInput,
  sandboxGuidance,
  shortSandboxGuidance,
  wrap,
} from './sandbox-guidance.ts';
export {
  type SandboxedLaunch,
  SandboxPolicy,
  type SandboxPolicyDeps,
  type SandboxRequirement,
  type SandboxStatusEntry,
  type SandboxTarget,
  type SandboxUnavailableFactory,
  type SandboxVerdict,
} from './sandbox-policy.ts';
export { ExclusiveSessionView, type ExclusiveViewHost } from './session-view.ts';
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
export { PlaywrightTemplateHost } from './template-host.ts';
export { TemplateSessionView } from './template-view.ts';
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
