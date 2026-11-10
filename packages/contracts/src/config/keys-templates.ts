/** @module contracts/config/keys-templates — session template keys delivered with templates T1a and T1b (spec 08 §5.9, spec 13 §11.6) */
import { z } from 'zod';
import { GRAMMAR_META_KEY } from './grammar.ts';
import { key } from './key.ts';
import { zBool, zBytes, zDuration, zInt } from './parsers.ts';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
const TWO_HOURS_MS = 7_200_000;

const zRecycleAfter = zDuration
  .refine((ms) => ms >= ONE_HOUR_MS, { message: "Expected a duration of at least '1h'." })
  .meta({ grammar: "a duration of at least '1h'" });

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const KEY_GRAMMAR = 'base64 of exactly 32 bytes (openssl rand -base64 32)';

/**
 * True when `value` is base64 (standard or URL-safe alphabet, padding optional) of exactly 32 bytes:
 * 43 characters, the last one carrying 2 zero bits.
 */
export function isTemplateKeyText(value: string): boolean {
  return /^[A-Za-z0-9+/_-]{42}[AEIMQUYcgkosw048]=?$/.test(value.trim());
}

/** `templateKey`, `templateKeyPrevious`: base64 of exactly 32 bytes (spec 13 §2.4); the value stays text. */
const zTemplateKey = z
  .string()
  .transform((value, ctx): string => {
    if (isTemplateKeyText(value)) return value.trim();
    // Never echo the value: it is a secret.
    ctx.addIssue({ code: 'custom', message: `Expected ${KEY_GRAMMAR}.` });
    return z.NEVER;
  })
  .meta({ [GRAMMAR_META_KEY]: KEY_GRAMMAR });

const zCheckpointInterval = zDuration
  .refine((ms) => ms >= ONE_MINUTE_MS, { message: "Expected a duration of at least '1m'." })
  .meta({ grammar: "a duration of at least '1m'" });

const zRecycleRss = zBytes
  .refine((bytes) => bytes >= 512 * MIB, { message: "Expected a size of at least '512MiB'." })
  .meta({ grammar: "a size of at least '512MiB'" });

const zDrainTimeout = zDuration
  .refine((ms) => ms >= ONE_MINUTE_MS && ms <= TWO_HOURS_MS, {
    message: "Expected a duration between '1m' and '2h'.",
  })
  .meta({ grammar: "a duration between '1m' and '2h'" });

/**
 * Keys of session templates (spec 08 §5.9, the T1a and T1b rows). They sit in the `sessions` help
 * group; `templateHealthInterval` arrives with T2.
 */
export const TEMPLATE_KEYS = {
  templates: key(zBool, {
    default: true,
    group: 'sessions',
    describe:
      'Session templates. false: list_templates answers TOOL_NOT_AVAILABLE, launch_session template answers TEMPLATE_NOT_FOUND, and no template browser starts.',
  }),
  templateKey: key(zTemplateKey, {
    optional: true,
    group: 'sessions',
    secret: true,
    describe:
      'Key that encrypts template checkpoints and versions (base64 of 32 bytes). Prefer BROWSERHIVE_TEMPLATE_KEY; absent = <dataDir>/admin/template.key, created on first use.',
  }),
  templateKeyPrevious: key(zTemplateKey, {
    optional: true,
    group: 'sessions',
    secret: true,
    describe:
      'The previous template key, read only: lets the server read files not yet re-encrypted by browserhive templates rekey.',
  }),
  templateCheckpointInterval: key(zCheckpointInterval, {
    default: 900_000,
    defaultText: '15m',
    group: 'sessions',
    describe:
      "How often a running template browser's rolling checkpoint is rewritten; versions are written at milestones only.",
  }),
  templateVersionsKeep: key(zInt(1, 100), {
    default: 10,
    group: 'sessions',
    describe:
      'Versions kept per template, plus every pinned version and the newest one with every site signed in.',
  }),
  templateRecycleRss: key(zRecycleRss, {
    default: 3 * GIB,
    defaultText: '3GiB',
    group: 'sessions',
    describe:
      "A template browser's resident memory above which its largest session's largest page is closed, then the browser is drained and restarted.",
  }),
  templateHostIdleTimeout: key(zDuration, {
    default: ONE_HOUR_MS,
    defaultText: '1h',
    group: 'sessions',
    describe:
      "How long a template's browser stays open with no session before it is stopped; 0 = never.",
  }),
  templateMaxPagesPerHost: key(zInt(2, 200), {
    default: 40,
    group: 'sessions',
    describe:
      'Agent pages per template browser (parked and maintenance pages excluded); each session may hold max(2, floor(value / cap)).',
  }),
  templateRecycleAfter: key(zRecycleAfter, {
    default: 86_400_000,
    defaultText: '24h',
    group: 'sessions',
    describe: "Age after which a template's browser is drained and restarted.",
  }),
  templateDrainTimeout: key(zDrainTimeout, {
    default: 900_000,
    defaultText: '15m',
    group: 'sessions',
    describe: 'How long a draining template browser waits for its sessions before closing them.',
  }),
} as const;
