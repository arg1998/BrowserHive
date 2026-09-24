/** @module contracts/config — configuration schema, parsers, key registry, JSON Schema and provenance types (D-06) */
export { ProvenanceSource } from '../enums/provenance-source.ts';
export { GRAMMAR_META_KEY, grammarFail, grammarOf } from './grammar.ts';
export { isIPv4, isIPv6, isLoopbackHost, zHost } from './host.ts';
export { CONFIG_FILE_SCHEMA_ID, CONFIG_REF_DEF, configFileJsonSchema } from './json-schema.ts';
export {
  CONFIG_GROUPS,
  type ConfigGroup,
  DERIVED_SOURCES,
  type DefaultKeyMeta,
  type Derived,
  type DerivedKeyMeta,
  type DerivedSource,
  derived,
  isKeyMeta,
  type KeyMeta,
  type KeyMetaInput,
  key,
  type OptionalKeyMeta,
  parseKeyMeta,
  readKeyMeta,
} from './key.ts';
export { LOGGING_KEYS, RECORDING_KEYS, TELEMETRY_KEYS } from './keys-observability.ts';
export { SERVER_KEYS } from './keys-server.ts';
export { SESSION_KEYS, STEALTH_KEYS } from './keys-sessions.ts';
export {
  formatBytes,
  formatDuration,
  formatLevelSpec,
  type LevelSpec,
  type MaxSessions,
  reservedMessage,
  zBool,
  zBytes,
  zDuration,
  zEnumOf,
  zInt,
  zLevelSpec,
  zList,
  zMap,
  zMaxSessions,
  zPath,
  zPort,
  zRatio,
  zReservedEnum,
  zString,
  zUrl,
} from './parsers.ts';
export {
  formatShadowLine,
  type KeyProvenance,
  type Provenance,
  type ShadowLine,
  type SuppliedValue,
  shadowLabel,
  sourceWithRefs,
  viaRefs,
} from './provenance.ts';
export {
  CONFIG_REF_PATTERN,
  type EnvLookup,
  type Expansion,
  expandRefs,
  firstRefLike,
  formatRefNames,
  REF_FORMS,
  REF_SCHEMES,
  type RefProblem,
  type RefScheme,
  type RefToken,
  refTokenText,
  scanRefs,
  type ValueRef,
} from './refs.ts';
export {
  CONFIG_KEYS,
  ENV_PREFIX,
  envNameOf,
  IDENTITY_ENV_VARS,
  type IdentityEnvVar,
  isIdentityEnvVar,
  KEY_ALIASES,
  type KeyLookup,
  type KeyNames,
  keyMeta,
  keysInGroup,
  lookupKey,
  namesFor,
  RESERVED_CONFIG_KEYS,
  RESERVED_ENUM_MEMBERS,
  type ReservedConfigKey,
  secretKeys,
} from './registry.ts';
export {
  type CrossFieldIssue,
  crossFieldIssues,
  type ExplicitKeys,
  isInsecureBind,
  NO_EXPLICIT_KEYS,
} from './rules.ts';
export { serverConfigSchema, serverConfigSchemaFor } from './schema.ts';
export {
  CONFIG_SHAPE,
  type ConfigKey,
  type ServerConfig,
  type ServerConfigInput,
  serverConfigObject,
} from './shape.ts';
