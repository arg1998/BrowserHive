/** @module contracts/enums/scope — authorization scopes checked by `Authorizer.can()` (spec 03 §3.5, D-09) */
import { z } from 'zod';

/**
 * v1 authorization scopes. Operators hold all; agents hold `mcp:tools` only; operator API tokens may hold a
 * subset. The five session-template and site-pack scopes (spec 13 §6.2, D-52) are appended, so the first
 * 19 keep the order an operator token issued with the 0.2.x full list stored (migration v9).
 */
export const Scope = z.enum([
  'sessions:read',
  'sessions:write',
  'sessions:takeover',
  'attention:read',
  'attention:resolve',
  'vault:read',
  'vault:write',
  'vault:confirm',
  'blocklist:read',
  'blocklist:write',
  'system:read',
  'system:write',
  'logs:read',
  'notifications:read',
  'notifications:write',
  'channels:read',
  'channels:write',
  'preferences:write',
  'mcp:tools',
  'templates:read',
  'templates:write',
  'templates:login',
  'sitepacks:read',
  'sitepacks:write',
]);
/** v1 authorization scope. */
export type Scope = z.infer<typeof Scope>;
