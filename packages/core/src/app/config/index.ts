/** @module app/config — configuration resolver: ladder, discovery, argv grammar, provenance views (spec 08) */
export {
  negatedName,
  type TokenizedArgs,
  type TokenizeOptions,
  tokenizeArgs,
} from './argv.ts';
export { CONSUMED_KEYS } from './consumers.ts';
export {
  deriveMaxSessions,
  hostRamGib,
  MAX_DERIVED_SESSIONS,
  osDefaultDataDir,
  RAM_GIB_PER_SESSION,
} from './data-dir.ts';
export {
  CONFIG_FILE_NAME,
  type ConfigFileOrigin,
  type ConfigFileStat,
  type ConfigFs,
  DATA_DIR_IN_DATA_DIR_MESSAGE,
  type DiscoveredConfigFile,
  type DiscoverInput,
  discoverConfigFile,
  readConfigFile,
} from './discover.ts';
export {
  type ConfigExitCode,
  type ConfigFailure,
  type ConfigFailureCode,
  type ConfigProblem,
  configFailure,
  type ProblemSource,
  renderProblem,
  withSuggestion,
} from './failure.ts';
export { isJsonObject, type JsonParseError, type JsonValue, parseJson } from './json-parse.ts';
export { type KeyKind, keyKind, PATH_KEYS, quoteRaw, REDACTED_TEXT, renderValue } from './kinds.ts';
export { type ConfigOverrides, OTEL_ENV_KEYS, UNSUPPORTED_HINT } from './layers.ts';
export {
  type ConfigShowRow,
  type ConfigView,
  type ConfigViewEntry,
  configShowRows,
  configSourceSummary,
  configView,
  REDACTED,
  type RedactedValue,
  shadowLines,
} from './provenance-view.ts';
export {
  type ConfigDiagnostics,
  type ResolveConfigInput,
  type ResolvedConfigBundle,
  resolveConfig,
} from './resolve.ts';
export {
  camelFromKebab,
  damerauLevenshtein,
  isRegisteredSpelling,
  type KeySuggestion,
  type SpellingSource,
  SUGGESTION_DISTANCE,
  suggest,
  suggestKey,
} from './suggest.ts';
