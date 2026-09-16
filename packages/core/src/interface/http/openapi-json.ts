/** @module interface/http/openapi-json — the canonical serialized OpenAPI document (what `scripts/gen-openapi.ts` commits and the golden compares). */

import type { Logger } from '../../ports/logger.ts';
import { VERSION } from '../../version.ts';
import { buildOpenApiDocument } from './openapi.ts';
import { apiRoutes } from './routes/index.ts';

const silent: Logger = {
  child: () => silent,
  isLevelEnabled: () => false,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

/** The document built from the full route table, as pretty JSON with a trailing newline. */
export function openApiDocumentJson(): string {
  let document: object = {};
  const routes = apiRoutes({ admin: true, logger: silent, document: () => document });
  document = buildOpenApiDocument(routes, VERSION);
  return `${JSON.stringify(document, null, 2)}\n`;
}
