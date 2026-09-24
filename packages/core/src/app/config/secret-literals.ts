/** @module app/config/secret-literals — the literals inside secret config values, registered with the always-on `SecretRegistry` at boot so they never reach a log, WS frame or OTLP payload (spec 10 §9). */

import type { ConfigKey, ServerConfig } from '@browserhive/contracts/config';

/** Pulls the literals worth scrubbing out of one secret key's resolved value. */
type Extractor<K extends ConfigKey> = (value: ServerConfig[K]) => readonly string[];

/**
 * Keys flagged `secret: true` in the config registry. Adding a secret key without an extractor fails
 * `secret-literals.test.ts`, so a new secret can never silently skip registration.
 */
export type SecretConfigKey = 'authTokens' | 'otelHeaders';

/**
 * `name:token` items → the token only. The name is a principal label that legitimately appears in
 * logs and the dashboard; registering it would scrub the operator's own token names.
 */
function tokensOf(items: readonly string[]): readonly string[] {
  return items.map((item) => item.slice(item.indexOf(':') + 1));
}

/**
 * Header values. For an `<scheme> <credential>` value (`Bearer abc…`) the credential is registered
 * as well, never the scheme word on its own: scrubbing every `Bearer` in the logs would be noise.
 */
function headerValuesOf(headers: Readonly<Record<string, string>>): readonly string[] {
  const out: string[] = [];
  for (const value of Object.values(headers)) {
    out.push(value);
    const credential = /^\S+\s+(\S.*)$/.exec(value)?.[1];
    if (credential !== undefined) out.push(credential);
  }
  return out;
}

/** One extractor per secret key. */
export const SECRET_LITERAL_EXTRACTORS: { readonly [K in SecretConfigKey]: Extractor<K> } = {
  authTokens: tokensOf,
  otelHeaders: headerValuesOf,
};

/**
 * Every secret literal in the resolved config. Short literals are still returned; the registry
 * itself ignores anything under its minimum length.
 */
export function secretConfigLiterals(config: ServerConfig): readonly string[] {
  return [
    ...SECRET_LITERAL_EXTRACTORS.authTokens(config.authTokens),
    ...SECRET_LITERAL_EXTRACTORS.otelHeaders(config.otelHeaders),
  ];
}
