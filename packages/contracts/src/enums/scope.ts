/** @module contracts/enums/scope — authorization scopes checked by `Authorizer.can()` (spec 03 §3.5, D-09) */
import { z } from 'zod';

/** v1 authorization scopes. Operators hold all; agents hold `mcp:tools` only; operator API tokens may hold a subset. */
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
  'preferences:write',
  'mcp:tools',
]);
/** v1 authorization scope. */
export type Scope = z.infer<typeof Scope>;
