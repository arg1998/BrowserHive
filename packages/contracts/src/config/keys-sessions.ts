/** @module contracts/config/keys-sessions — session, browser and stealth keys (spec 08 §5.2) */
import type { z } from 'zod';
import { Channel } from '../enums/channel.ts';
import { SandboxMode } from '../enums/sandbox-mode.ts';
import { StealthDriver } from '../enums/stealth-driver.ts';
import { StealthLevel } from '../enums/stealth-level.ts';
import { derived, key } from './key.ts';
import { zBool, zDuration, zEnumOf, zMaxSessions, zPath, zReservedEnum } from './parsers.ts';

const ONE_MINUTE_MS = 60_000;

const zLeaseDuration = zDuration
  .refine((ms) => ms >= ONE_MINUTE_MS, { message: "Expected a duration of at least '1m'." })
  .meta({ grammar: "a duration of at least '1m'" });

/** Keys of the `sessions` group. */
export const SESSION_KEYS = {
  persistence: key(zReservedEnum(['memory', 'persistent', 'storage-state'], ['blueprint']), {
    default: 'memory',
    group: 'sessions',
    describe: 'Default persistence mode; launch_session persistence_mode overrides per session.',
  }),
  defaultHeadless: key(zBool, {
    default: true,
    group: 'sessions',
    describe: 'Default headless mode; launch_session headless overrides per session.',
  }),
  defaultChannel: key(zEnumOf(Channel.options), {
    default: 'chromium',
    group: 'sessions',
    describe: 'Default browser channel; launch_session channel overrides per session.',
  }),
  sandbox: key(zEnumOf(SandboxMode.options), {
    default: 'off',
    group: 'sessions',
    describe:
      "Chromium's sandbox. auto runs each browser sandboxed where it can and falls back where it cannot (warned once); on requires it: the server refuses to start (exit 3) and a session fails with SANDBOX_UNAVAILABLE when a browser cannot provide it; off never uses it.",
  }),
  maxSessions: key(zMaxSessions, {
    default: derived('hostMemory'),
    group: 'sessions',
    describe:
      'Maximum concurrent browser sessions, or unbounded. Derived from available RAM when unset (min(floor(GiB / 1.5), 20); on Linux, host RAM capped by the cgroup memory limit).',
  }),
  sessionLease: key(zLeaseDuration, {
    default: 7_200_000,
    defaultText: '2h',
    group: 'sessions',
    describe: 'Sliding inactivity lease after which an idle session is reaped.',
  }),
  attentionTimeout: key(zLeaseDuration, {
    default: 21_600_000,
    defaultText: '6h',
    group: 'sessions',
    describe: 'Server cap on how long request_attention may block.',
  }),
  minAttentionWait: key(zDuration, {
    default: 1_800_000,
    defaultText: '30m',
    group: 'sessions',
    describe:
      'Floor for request_attention max_wait; 0 disables it. Must be less than attentionTimeout.',
  }),
  allowEvaluate: key(zBool, {
    default: true,
    group: 'sessions',
    describe: 'Allow the evaluate tool. false makes every evaluate return EVALUATE_DISABLED.',
  }),
  blocklist: key(zPath, {
    optional: true,
    group: 'sessions',
    describe: 'URL blocklist file (one glob per line). Unreadable at startup is fatal.',
  }),
  blocklistWatch: key(zBool, {
    default: false,
    group: 'sessions',
    describe: 'Reload the blocklist when the file changes (debounced). Requires blocklist.',
  }),
  vault: key(zReservedEnum(['off', 'bitwarden'], ['local', 'onepassword', 'http']), {
    default: 'off',
    group: 'sessions',
    describe: 'Credential vault backend.',
  }),
} as const;

/** Keys of the `stealth` group. */
export const STEALTH_KEYS = {
  stealth: key(zEnumOf(StealthLevel.options), {
    default: 'standard',
    group: 'stealth',
    describe: 'Stealth level. max also defaults fingerprint to true.',
  }),
  stealthDriver: key(zEnumOf(StealthDriver.options), {
    default: 'auto',
    group: 'stealth',
    describe:
      'Chromium driver for stealth sessions. auto uses Patchright when installed, else Playwright.',
  }),
  fingerprint: key(zBool, {
    default: derived('stealth'),
    group: 'stealth',
    describe: 'Coherent fingerprint identity per session. Defaults to true only when stealth=max.',
  }),
  humanize: key(zBool, {
    default: false,
    group: 'stealth',
    describe: 'Human-like cursor movement and typing cadence. Requires stealth standard or max.',
  }),
  captcha: key(zReservedEnum(['attention', 'off'], ['solver']), {
    default: 'attention',
    group: 'stealth',
    describe: 'CAPTCHA policy. attention hands the page to an operator (needs admin and http).',
  }),
} as const;

/** Output type of the session keys (used by the cross-field rules). */
export type SessionKeysOutput = z.output<z.ZodObject<typeof SESSION_KEYS>>;
/** Output type of the stealth keys (used by the cross-field rules). */
export type StealthKeysOutput = z.output<z.ZodObject<typeof STEALTH_KEYS>>;
