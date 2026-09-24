/** @module interface/mcp — public surface of the MCP interface: server factory, dispatcher, registry, transports, tool definitions. */

export { requireSession, type ToolCallContext } from './context.ts';
export {
  type AnyToolDefinition,
  type ContentBlock,
  DEFAULT_TELEMETRY,
  defineTool,
  json,
  type PageVisit,
  type PolicyContext,
  type ScreenshotArtifact,
  type ToolDefinition,
  type ToolFacts,
  type ToolPack,
  type ToolPolicy,
  type ToolRequirements,
  type ToolResult,
  type ToolTelemetry,
} from './definition.ts';
export {
  type DispatchCall,
  invalidArguments,
  TOOL_SPAN,
  ToolDispatcher,
  type ToolDispatcherDeps,
} from './dispatcher.ts';
export {
  evaluateAllowed,
  evaluateDisabledMessage,
  sandboxPath,
  sessionOwnership,
  transportHttp,
  urlBlocklist,
  vaultEnabled,
} from './policies.ts';
export { authInfoFor, isRequestPrincipal, principalFromAuthInfo } from './principal.ts';
export {
  ALL_TOOL_NAMES,
  createToolRegistry,
  REGISTERED_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_PACK_LIST,
  type ToolRegistry,
  type ToolRegistryOptions,
} from './registry.ts';
export type { RuntimeFacts } from './runtime.ts';
export {
  resolveScreenshotSavePath,
  resolveUploadPath,
  UPLOADS_DIR_NAME,
  uploadsDir,
} from './sandbox.ts';
export {
  type CreateMcpServerOptions,
  createMcpServer,
  SERVER_NAME,
  serverInstructions,
} from './server.ts';
export type {
  AttentionLike,
  AuthStatesLike,
  BlocklistLike,
  ToolFs,
  ToolRedaction,
  ToolServices,
  VaultLike,
} from './services.ts';
export { ERROR_META_KEY } from './shape.ts';
export { createNodeToolFs, TOOL_DIR_MODE } from './tool-fs.ts';
export { classifyToolOutcome, SOFT_ERROR_CODES, type SoftFailure } from './tool-outcome.ts';
export { InMemoryEventStore } from './transports/event-store.ts';
export {
  createMcpHttpHandler,
  MCP_KEEP_ALIVE_MS,
  MCP_SESSION_HEADER,
  type McpHttpHandler,
  type McpHttpOptions,
  type McpSessionClosed,
} from './transports/http.ts';
export { LOCAL_PRINCIPAL, startStdio } from './transports/stdio.ts';
