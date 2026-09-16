/** @module contracts/errors — error registry, codes, projections and helpers (D-07) */
export { ErrorCategory } from '../enums/error-category.ts';
export { Retryable } from '../enums/retryable.ts';
export { type HttpAuditCode, httpAuditCode, httpAuditStatus, isHttpAuditCode } from './audit.ts';
export { AUDIT_ERRORS, SessionWarningDetails, WARNING_ERRORS } from './codes-audit-warning.ts';
export { AUTH_ERRORS, TRANSPORT_ERRORS } from './codes-auth-transport.ts';
export { BOOT_ERRORS } from './codes-boot.ts';
export { PAGE_ERRORS } from './codes-page.ts';
export { SERVICE_ERRORS } from './codes-service.ts';
export { SESSION_ERRORS } from './codes-session.ts';
export {
  ERROR_DOCS_URL,
  errorDocsUrl,
  McpErrorContent,
  ProblemDetails,
  WsErrorPayload,
} from './projections.ts';
export {
  type AuditCode,
  codesInCategory,
  ERROR_CODES,
  ERROR_REGISTRY,
  type ErrorCode,
  ErrorCodeSchema,
  type ErrorDetails,
  type ErrorSpec,
  errorSpec,
  isErrorCode,
} from './registry.ts';
export { type BootExitCode, defineError, type ErrorSpecShape, renderMessage } from './spec.ts';
