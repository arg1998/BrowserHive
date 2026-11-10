/** @module contracts/config/keys-templates — session template keys delivered with templates T1a (spec 08 §5.9, spec 13 §11.6) */
import { key } from './key.ts';
import { zBool, zDuration, zInt } from './parsers.ts';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
const TWO_HOURS_MS = 7_200_000;

const zRecycleAfter = zDuration
  .refine((ms) => ms >= ONE_HOUR_MS, { message: "Expected a duration of at least '1h'." })
  .meta({ grammar: "a duration of at least '1h'" });

const zDrainTimeout = zDuration
  .refine((ms) => ms >= ONE_MINUTE_MS && ms <= TWO_HOURS_MS, {
    message: "Expected a duration between '1m' and '2h'.",
  })
  .meta({ grammar: "a duration between '1m' and '2h'" });

/**
 * Keys of session templates (spec 08 §5.9, the T1a rows). They sit in the `sessions` help group;
 * `templateKey`, `templateKeyPrevious`, `templateCheckpointInterval`, `templateVersionsKeep` and
 * `templateRecycleRss` arrive with T1b, `templateHealthInterval` with T2.
 */
export const TEMPLATE_KEYS = {
  templates: key(zBool, {
    default: true,
    group: 'sessions',
    describe:
      'Session templates. false: list_templates answers TOOL_NOT_AVAILABLE, launch_session template answers TEMPLATE_NOT_FOUND, and no template browser starts.',
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
