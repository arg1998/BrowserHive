/** @module public/server — `@browserhive/core/server`: the heavy server graph (browsers, sessions, vault, attention, MCP, HTTP, WS, static) the composition root wires; import only when serving. */

export { AttentionService } from '../app/attention/attention-service.ts';
export { AuthStateStore } from '../app/auth-states/store.ts';
export { type BlocklistFileWatcher, BlocklistService } from '../app/blocklist/blocklist-service.ts';
export { configView } from '../app/config/provenance-view.ts';
export { InProcessEventBus } from '../app/events/bus.ts';
export { NotificationService } from '../app/notifications/notification-service.ts';
export { Recorder } from '../app/observability/recorder.ts';
export { SystemStatusService } from '../app/observability/system-status.ts';
export { PreferenceService } from '../app/preferences/preference-service.ts';
export { LeaseSweeper } from '../app/sessions/lease-sweeper.ts';
export { sessionDirLayout } from '../app/sessions/profile-dir.ts';
export { SessionService } from '../app/sessions/session-service.ts';
export { VaultService } from '../app/vault/vault-service.ts';
export { OperatorRequestBroker } from '../domain/operator-requests/broker.ts';
export { VaultBroker } from '../domain/vault/broker.ts';
export { VaultRedaction } from '../domain/vault/redaction.ts';
export { installBlocklistRoute } from '../infra/browsers/blocklist-route.ts';
export { bundledChromiumVersion } from '../infra/browsers/bundled-chromium.ts';
export {
  assertChromiumInstalled,
  pinnedPlaywrightVersion,
} from '../infra/browsers/chromium-resolver.ts';
export { DriverResolver } from '../infra/browsers/driver-resolver.ts';
export { HostGeoSeedResolver } from '../infra/browsers/geo-seed.ts';
export type { HostFacts } from '../infra/browsers/host-facts.ts';
export { createVaultHumanTyper } from '../infra/browsers/humanize/vault-typer.ts';
export { resolveIdentity } from '../infra/browsers/identity-resolver.ts';
export { createPlaywrightPageActions } from '../infra/browsers/page-actions.ts';
export { PlaywrightBrowserDriver } from '../infra/browsers/playwright-browser-driver.ts';
export { PassThroughProxyResolver } from '../infra/browsers/proxy.ts';
export { createBunDesktop } from '../infra/desktop/bun-desktop.ts';
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
