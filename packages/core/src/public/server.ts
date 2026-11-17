/** @module public/server — `@browserhive/core/server`: the heavy server graph (browsers, sessions, vault, attention, MCP, HTTP, WS, static) the composition root wires; import only when serving. */

export { AttentionService } from '../app/attention/attention-service.ts';
export { AuthStateStore } from '../app/auth-states/store.ts';
export { type BlocklistFileWatcher, BlocklistService } from '../app/blocklist/blocklist-service.ts';
export { configView } from '../app/config/provenance-view.ts';
export { InProcessEventBus } from '../app/events/bus.ts';
export {
  type ActionCounter,
  type ActionExecutor,
  type ChannelAdapterFactory,
  ChannelRegistry,
  ChannelService,
  createLocalLinkBuilder,
  createReportFacts,
  type DeliveryCounter,
  forgetChannelCursors,
  imageVariants,
  linkBuilderFor,
  NotificationActionListeners,
  NotificationActionService,
  NotificationOutbox,
  NotificationService,
  PublicUrlChecker,
  publicUrlHost,
  type ReportCounter,
  ReportScheduler,
  ReportService,
  ReportSettingsStore,
  runtimeZone,
} from '../app/notifications/index.ts';
export { Recorder } from '../app/observability/recorder.ts';
export { SystemStatusService } from '../app/observability/system-status.ts';
export { PreferenceService } from '../app/preferences/preference-service.ts';
export { LeaseSweeper } from '../app/sessions/lease-sweeper.ts';
export { sessionDirLayout } from '../app/sessions/profile-dir.ts';
export { SessionService } from '../app/sessions/session-service.ts';
export { AgentNavigations } from '../app/site-packs/agent-navigations.ts';
export { ChallengeOutcomes } from '../app/site-packs/challenge-outcomes.ts';
export { ChallengeWatch } from '../app/site-packs/challenge-watch.ts';
export { DeviceBindingWatch } from '../app/site-packs/device-binding.ts';
export { SiteKeeper } from '../app/site-packs/keeper.ts';
export { WritePacer } from '../app/site-packs/pacer.ts';
export { PackProber, packProberSelector } from '../app/site-packs/pack-prober.ts';
export { maintenanceProbePages } from '../app/site-packs/probe-pages.ts';
export { SitePackRegistry } from '../app/site-packs/registry.ts';
export { assembleSnapshot, resolvePacks } from '../app/site-packs/registry-build.ts';
export type { PendingUpdate, SitePackRegistryDeps } from '../app/site-packs/registry-types.ts';
// Site-pack enforcement (spec 13 §9.3, §9.5; PR T3a, WP-E1).
export { SecurityInterceptService } from '../app/site-packs/security-intercepts.ts';
export { TemplateSiteStops } from '../app/site-packs/site-stops.ts';
export { AgentSiteVisits } from '../app/site-packs/site-visits.ts';
export { SiteActionStrategies } from '../app/site-packs/strategies/site-actions.ts';
export { SiteToolGate } from '../app/site-packs/tool-gate.ts';
export { ToolGuardHits } from '../app/site-packs/tool-guard-hits.ts';
export { HostFlagsWatch } from '../app/site-packs/webrtc-host-flags.ts';
export { TemplateWritePolicies } from '../app/site-packs/write-policies.ts';
export { watchClipboardOnStart } from '../app/templates/clipboard-switch.ts';
export { unavailableHealthFacade } from '../app/templates/health-facade.ts';
export {
  type TemplateHealthParts,
  wireTemplateHealth,
} from '../app/templates/health-wiring.ts';
export { displayMissing } from '../app/templates/host-display.ts';
export {
  RECORDING_SLUG,
  TemplateHostOperations,
} from '../app/templates/host-operations.ts';
export { TemplateHostSupervisor } from '../app/templates/host-supervisor.ts';
export type {
  HostSupervisorConfig,
  HostSupervisorDeps,
} from '../app/templates/host-supervisor-types.ts';
export { reloginActionExecutor } from '../app/templates/relogin-executor.ts';
export { type ProberSelector, selectGenericProber } from '../app/templates/site-prober.ts';
export { reconcileTemplateState } from '../app/templates/state-reconcile.ts';
export { TemplateActions } from '../app/templates/template-actions.ts';
export { TemplateEditService } from '../app/templates/template-edit.ts';
export { TemplateOperations } from '../app/templates/template-operations.ts';
export { TemplateRecordingService } from '../app/templates/template-recording.ts';
export {
  TemplateService,
  type TemplateServiceConfig,
} from '../app/templates/template-service.ts';
export { TemplateStateService } from '../app/templates/template-state.ts';
export {
  UnavailableTemplateHostOps,
  UnavailableTemplateRuntime,
} from '../app/templates/unavailable-runtime.ts';
export { VaultService } from '../app/vault/vault-service.ts';
export { OperatorRequestBroker } from '../domain/operator-requests/broker.ts';
export { issuesText, loadPackBytes, sha256Hex } from '../domain/site-packs/load.ts';
export {
  type TemplateKey,
  templateKeyId,
  templateKeyOf,
} from '../domain/templates/envelope.ts';
export { VaultBroker } from '../domain/vault/broker.ts';
export { VaultRedaction } from '../domain/vault/redaction.ts';
export { installBlocklistRoute } from '../infra/browsers/blocklist-route.ts';
export {
  type BrowserDetectionDeps,
  CHANNEL_LABEL,
  type CommandOutput,
  channelExecutable,
  type DetectedBrowser,
  detectBrowsers,
  type ManagedPolicies,
  playwrightChannelExecutable,
} from '../infra/browsers/browser-detection.ts';
export { bundledChromiumVersion } from '../infra/browsers/bundled-chromium.ts';
export { assertChromiumInstalled } from '../infra/browsers/chromium-resolver.ts';
export { applyClipboardPolicy } from '../infra/browsers/clipboard-policy.ts';
export { DRIVER_NAME, driverChromium, driverVersion } from '../infra/browsers/driver.ts';
export { CdpPageFocus } from '../infra/browsers/focus-emulation.ts';
export { HostGeoSeedResolver } from '../infra/browsers/geo-seed.ts';
export type { HostFacts } from '../infra/browsers/host-facts.ts';
export { createVaultHumanTyper } from '../infra/browsers/humanize/vault-typer.ts';
export { resolveIdentity } from '../infra/browsers/identity-resolver.ts';
export { createPlaywrightPageActions } from '../infra/browsers/page-actions.ts';
export { PlaywrightBrowserDriver } from '../infra/browsers/playwright-browser-driver.ts';
export {
  isVerifiedDriverVersion,
  onPreflightRefusal,
  type PreflightEnforcement,
  preflightEnforcement,
  VERIFIED_DRIVER_VERSIONS,
  verifyPreflightDriver,
} from '../infra/browsers/preflight-enforcement.ts';
export { PassThroughProxyResolver } from '../infra/browsers/proxy.ts';
export {
  APPARMOR_PROFILE_NAME,
  apparmorProfile,
  apparmorProfileCovers,
  inspectSandboxEnvironment,
  probeSandbox,
  type SandboxEnvironment,
  type SandboxProbeResult,
} from '../infra/browsers/sandbox.ts';
export { sandboxUnavailable } from '../infra/browsers/sandbox-error.ts';
export {
  type GuidanceAlternative,
  type GuidanceTarget,
  renderSandboxGuidance,
  type SandboxGuidance,
  type SandboxGuidanceInput,
  sandboxGuidance,
  shortSandboxGuidance,
} from '../infra/browsers/sandbox-guidance.ts';
export {
  SandboxPolicy,
  type SandboxRequirement,
  type SandboxStatusEntry,
  type SandboxTarget,
  type SandboxUnavailableFactory,
} from '../infra/browsers/sandbox-policy.ts';
export { createTemplateGeoResolver } from '../infra/browsers/template-geo.ts';
export type { TemplateRequestGuard } from '../infra/browsers/template-launch.ts';
export { createBunDesktop } from '../infra/desktop/bun-desktop.ts';
export { createTemplateFiles } from '../infra/fs/template-files.ts';
export {
  decodeTemplateKey,
  type ResolvedTemplateKeys,
  readKeyFile,
  resolveTemplateKeys,
  type TemplateKeySource,
  templateKeyPath,
} from '../infra/fs/template-key.ts';
export { type RekeyResult, rekeyTemplateFiles } from '../infra/fs/template-rekey.ts';
export { FileTemplateStateStore } from '../infra/fs/template-state-store.ts';
export { sweepStaleTemplateBrowsers } from '../infra/host/stale-template-browsers.ts';
export { profileHasSecrets } from '../infra/persistence/profile-secrets.ts';
export { BundledIndex, BundledPackSource } from '../infra/site-packs/bundled-source.ts';
export { documentGuardResolver } from '../infra/site-packs/document-guard.ts';
export { SiteGuardHitsWriter } from '../infra/site-packs/guard-hits-writer.ts';
export { GuardRuleCatalog, PackGuardRuleSource } from '../infra/site-packs/guard-rules.ts';
export { LocalPackSource } from '../infra/site-packs/local-source.ts';
export { createLocalPackWriter, createSitePackCache } from '../infra/site-packs/pack-cache.ts';
export { NO_SITE_PACKS, templateRequestGuard } from '../infra/site-packs/template-guard.ts';
export { createArtifactFiles } from '../infra/static/artifact-files.ts';
export { createBunStaticAssets } from '../infra/static/bun-static-assets.ts';
export { createTraceViewerAssets } from '../infra/static/playwright-trace-viewer.ts';
export { BitwardenBackend } from '../infra/vault-backends/bitwarden/bitwarden-backend.ts';
export { OffVaultBackend } from '../infra/vault-backends/off.ts';
export { createHttpApp, type HttpApp } from '../interface/http/app.ts';
export type {
  BlocklistPort,
  HealthProbe,
  HttpServices,
  LogLevelController,
  NotificationsPort,
  PreferencesPort,
} from '../interface/http/services.ts';
export { ToolDispatcher } from '../interface/mcp/dispatcher.ts';
export {
  ConnectionIdentity,
  type ConnectionSignals,
  connectionPatchOf,
  type ResolvedIdentity,
} from '../interface/mcp/identity.ts';
export { createToolRegistry } from '../interface/mcp/registry.ts';
export type { RuntimeFacts } from '../interface/mcp/runtime.ts';
export { createMcpServer } from '../interface/mcp/server.ts';
export { createNodeToolFs } from '../interface/mcp/tool-fs.ts';
export { createMcpHttpHandler, type McpHttpHandler } from '../interface/mcp/transports/http.ts';
export { startStdio } from '../interface/mcp/transports/stdio.ts';
export { playwrightBridgeFactory } from '../interface/ws/cdp-bridge.ts';
export { createRealtimeHub, type Realtime } from '../interface/ws/index.ts';
export type { PageActions } from '../ports/page-actions.ts';
export type { SessionPolicyInstaller } from '../ports/session-policies.ts';
export type { TemplateFiles } from '../ports/template-files.ts';
export type { TemplateRuntime } from '../ports/template-runtime.ts';
