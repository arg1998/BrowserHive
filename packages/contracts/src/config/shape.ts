/** @module contracts/config/shape — the key shape and the strict object of every key (no cross-field rules) */
import { z } from 'zod';
import { LOGGING_KEYS, RECORDING_KEYS, TELEMETRY_KEYS } from './keys-observability.ts';
import { SERVER_KEYS } from './keys-server.ts';
import { SESSION_KEYS, STEALTH_KEYS } from './keys-sessions.ts';

/** Every key schema, in help order (server, sessions, stealth, logging, recording, telemetry). */
export const CONFIG_SHAPE = {
  ...SERVER_KEYS,
  ...SESSION_KEYS,
  ...STEALTH_KEYS,
  ...LOGGING_KEYS,
  ...RECORDING_KEYS,
  ...TELEMETRY_KEYS,
} as const;

/** The strict object of every key, before cross-field rules. */
export const serverConfigObject = z.object(CONFIG_SHAPE).strict();

/** Resolved, validated configuration (output type; derived keys present, optional keys absent when unset). */
export type ServerConfig = z.output<typeof serverConfigObject>;

/** What the config sources may supply (input type: everything with a default is optional). */
export type ServerConfigInput = z.input<typeof serverConfigObject>;

/** Union of every canonical key name. */
export type ConfigKey = keyof typeof CONFIG_SHAPE;
