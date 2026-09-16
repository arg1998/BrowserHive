/** @module domain/auth — pure identity model: principals, scopes, authorizer policy, token grammar, cookie data. */

export {
  type AuthorizedResource,
  type Authorizer,
  allowedDuringPasswordChange,
  assertCan,
  authorizer,
  can,
} from './authorizer.ts';
export {
  bearerTokenFromHeader,
  type CookieAttributes,
  clearSessionCookie,
  parseCookieHeader,
  SESSION_COOKIE_MAX_AGE_S,
  SESSION_COOKIE_NAME,
  type SetCookie,
  serializeCookie,
  sessionCookie,
  sessionTokenFromCookie,
} from './cookie.ts';
export { constantTimeEqual, matchesHash, sha256Hex } from './digest.ts';
export {
  assertPasswordPolicy,
  checkPasswordPolicy,
  type PasswordPolicyViolation,
} from './password-policy.ts';
export {
  agentPrincipal,
  isLocalPrincipal,
  isSessionPrincipal,
  LOCAL_PRINCIPAL,
  LOCAL_SUBJECT,
  type PrincipalAuth,
  type PrincipalAuthMethod,
  type PrincipalFromRecordOptions,
  principalFromRecord,
  type RequestPrincipal,
} from './principal.ts';
export {
  AGENT_SCOPES,
  ALL_SCOPES,
  isScope,
  isSubsetOf,
  OPERATOR_SCOPES,
  parseScopes,
  SERVICE_SCOPES,
  scopesForKind,
} from './scopes.ts';
export {
  base64Url,
  generateSeedPassword,
  idPrefix,
  mintSecret,
  mintToken,
  type ParsedToken,
  PUBLIC_PREFIX_LENGTH,
  parseToken,
  SEED_ALPHABET,
  SEED_PASSWORD_LENGTH,
  TOKEN_BYTES,
  TOKEN_RE,
  type TokenKind,
} from './token-format.ts';
