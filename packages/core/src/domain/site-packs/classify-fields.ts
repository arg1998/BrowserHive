/** @module domain/site-packs/classify-fields — the per-field rules of spec 13 §9.7 for everything but guards, challenges and strategies: a rule per top-level field, and **default deny** (a path no rule names is loosening). Values are read from the two parsed versions, not from the diff's JSON, so defaults always apply. */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import type { SitePackChangeFieldRecord } from '../../ports/persistence/site-packs.ts';
import { keyedPath, lowered, ordered, raised, switchedOn } from './classify-order.ts';
import { classifyChallengeChange, classifyGuardChange } from './classify-rules.ts';
import { classifyStrategyChange } from './classify-strategies.ts';
import type { ChangeClass, ClassifyInput } from './classify-types.ts';

type FieldRule = (path: string, input: ClassifyInput) => ChangeClass;

/** Display-only fields: any change is neutral. */
const NEUTRAL = (): ChangeClass => 'neutral';
/** Path- and URL-bearing or scope fields: any change is loosening. */
const LOOSENING = (): ChangeClass => 'loosening';

/** The rule of each top-level field; a field missing here is loosening (default deny). */
const RULES: Readonly<Record<string, FieldRule>> = {
  title: NEUTRAL,
  description: NEUTRAL,
  verified: NEUTRAL,
  sources: NEUTRAL,
  min_client: NEUTRAL,
  max_client: NEUTRAL,
  domains: LOOSENING,
  identity_provider: LOOSENING,
  shares_login_with: LOOSENING,
  signed_in: LOOSENING,
  sign_in: signInRule,
  keeper: keeperRule,
  write_policy: writePolicyRule,
  concurrency: concurrencyRule,
  pacing: pacingRule,
  browser: browserRule,
  consistency: consistencyRule,
  device_binding: deviceBindingRule,
  guards: (path, input) =>
    keyed(path, 'guards', (id, rest) => classifyGuardChange('guards', id, rest, input)),
  element_guards: (path, input) =>
    keyed(path, 'element_guards', (id, rest) =>
      classifyGuardChange('element_guards', id, rest, input),
    ),
  challenges: (path, input) =>
    keyed(path, 'challenges', (id, rest) => classifyChallengeChange(id, rest, input)),
  strategies: (path, input) =>
    keyed(path, 'strategies', (id, rest) => classifyStrategyChange(id, rest, input)),
};

/** The class of one field change (spec 13 §9.7). */
export function classifyField(
  change: SitePackChangeFieldRecord,
  input: ClassifyInput,
): ChangeClass {
  const top = /^[a-z_]+/.exec(change.path)?.[0] ?? '';
  const rule = Object.hasOwn(RULES, top) ? RULES[top] : undefined;
  return rule === undefined ? 'loosening' : rule(change.path, input);
}

/** `<list>[<id>]<rest>` → the rule for that entry; any other shape of path is loosening. */
function keyed(
  path: string,
  list: string,
  rule: (id: string, rest: string) => ChangeClass,
): ChangeClass {
  const parsed = keyedPath(path, list);
  return parsed === null ? 'loosening' : rule(parsed.id, parsed.rest);
}

// --- field rules -------------------------------------------------------------------------------

function signInRule(path: string, { from, to }: ClassifyInput): ChangeClass {
  if (path === 'sign_in.human_only') {
    return switchedOn(from.sign_in?.human_only, to.sign_in?.human_only);
  }
  return 'loosening';
}

function keeperRule(path: string, { from, to }: ClassifyInput): ChangeClass {
  if (path === 'keeper.interval_hours') {
    return raised(from.keeper?.interval_hours, to.keeper?.interval_hours);
  }
  // `keeper.path` is a path BrowserHive loads; a keeper added or removed changes what it visits.
  return 'loosening';
}

function writePolicyRule(path: string, { from, to }: ClassifyInput): ChangeClass {
  if (path === 'write_policy.default') {
    return ordered(
      ['allow', 'warn', 'confirm'],
      from.write_policy.default,
      to.write_policy.default,
    );
  }
  if (
    path === 'write_policy.stance' ||
    path === 'write_policy.exception' ||
    path === 'write_policy.clause' ||
    path.startsWith('write_policy.clause.')
  ) {
    return 'neutral';
  }
  return 'loosening';
}

function concurrencyRule(path: string, { from, to }: ClassifyInput): ChangeClass {
  if (path === 'concurrency') {
    // A cap added is a cap lowered from none; removed is raised to none.
    if (from.concurrency === undefined && to.concurrency !== undefined) {
      return to.concurrency.max_sessions <= 1 ? 'restrictive' : 'tightening';
    }
    return 'loosening';
  }
  if (path === 'concurrency.max_sessions') {
    return lowered(from.concurrency?.max_sessions, to.concurrency?.max_sessions);
  }
  if (path === 'concurrency.source' || path.startsWith('concurrency.source.')) return 'neutral';
  return 'loosening';
}

function pacingRule(path: string, input: ClassifyInput): ChangeClass {
  const { from, to } = input;
  if (path === 'pacing') {
    if (from.pacing === undefined && to.pacing !== undefined) {
      return to.pacing.rules.some((r) => r.limit <= 1) ? 'restrictive' : 'tightening';
    }
    return 'loosening';
  }
  if (path === 'pacing.min_launch_gap_s') {
    return raised(from.pacing?.min_launch_gap_s ?? 0, to.pacing?.min_launch_gap_s ?? 0);
  }
  const parsed = keyedPath(path, 'pacing.rules');
  if (parsed === null) return 'loosening';
  const before = from.pacing?.rules.find((r) => r.id === parsed.id);
  const after = to.pacing?.rules.find((r) => r.id === parsed.id);
  if (parsed.rest === '') {
    if (before === undefined && after !== undefined) {
      return after.limit <= 1 ? 'restrictive' : 'tightening';
    }
    return 'loosening';
  }
  if (parsed.rest === 'limit') return lowered(before?.limit, after?.limit);
  if (parsed.rest === 'source' || parsed.rest.startsWith('source.')) return 'neutral';
  // `per`, `guard` and `kind` have no rule: default deny.
  return 'loosening';
}

function browserRule(path: string, { from, to }: ClassifyInput): ChangeClass {
  if (path === 'browser.headed') {
    if (to.browser.headed === 'required' && from.browser.headed !== 'required') {
      return 'restrictive';
    }
    return ordered(['any', 'preferred', 'required'], from.browser.headed, to.browser.headed);
  }
  // `browser.channel`: any change is loosening.
  return 'loosening';
}

function consistencyRule(path: string, { from, to }: ClassifyInput): ChangeClass {
  const a = from.consistency;
  const b = to.consistency;
  switch (path) {
    case 'consistency.proxy':
      return ordered(['any', 'recommended'], a.proxy, b.proxy);
    case 'consistency.pin_geo':
      return switchedOn(a.pin_geo, b.pin_geo);
    case 'consistency.pin_timezone':
      return switchedOn(a.pin_timezone, b.pin_timezone);
    case 'consistency.pin_locale':
      return switchedOn(a.pin_locale, b.pin_locale);
    default:
      return 'loosening';
  }
}

/**
 * `device_binding` is diffed by position, so every one of its changes gets the class of the list
 * as a whole: an entry (platform and mechanism) removed is loosening, else one added is tightening,
 * else only `since` or `source` moved (neutral).
 */
function deviceBindingRule(_path: string, { from, to }: ClassifyInput): ChangeClass {
  const keys = (pack: SitePackV1) =>
    new Set(pack.device_binding.map((d) => `${d.platform}/${d.mechanism}`));
  const before = keys(from);
  const after = keys(to);
  if ([...before].some((k) => !after.has(k))) return 'loosening';
  if ([...after].some((k) => !before.has(k))) return 'tightening';
  return 'neutral';
}
