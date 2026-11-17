/** @module domain/site-packs/refine — the pack-level refinements of spec 13 §9.2 and §9.10 that the structural schema cannot express: registrable domains, scoped URLs and globs, the selector grammar, references between guards, the stance rule, numeric ceilings, and paths BrowserHive loads by itself that the pack's own guards would match. Used by the registry, `sitepacks verify` and the tests. */

import { PACE_CEILING, type SitePackV1 } from '@browserhive/contracts/site-packs';
import { registrableDomain } from '../../kernel/url.ts';
import {
  compileRequestGuardRules,
  matchRequestGuard,
  type RequestGuardRuleInput,
} from '../policies/request-guard.ts';
import { isAnchoredChallenge } from './challenges.ts';
import { checkPackSelector } from './css-selector.ts';
import { scopedUrl, scopeOfGlob } from './glob-scope.ts';
import { strategyParamIssues } from './strategy-specs.ts';
import { unsafeTextIssues } from './text-safety.ts';

/** One refinement failure: a JSON path into the pack and why. */
export interface PackIssue {
  readonly path: string;
  readonly message: string;
}

/** The refinement outcome: issues refuse the version; warnings are shown, nothing more. */
export interface RefineResult {
  readonly issues: readonly PackIssue[];
  readonly warnings: readonly string[];
}

/** Guard kinds a path BrowserHive loads by itself must never match (spec 13 §9.10). */
const PROTECTED_KINDS: ReadonlySet<string> = new Set([
  'logout',
  'account',
  'credential',
  'destructive',
]);

/** The default write policy the stance rule asks for (spec 13 §9.3). */
export const STANCE_DEFAULT = {
  prohibited: 'confirm',
  writes_restricted: 'confirm',
  restricted: 'warn',
  allowed: 'allow',
} as const;

/**
 * Every refinement of a parsed pack. Never throws; an empty `issues` list means the version may
 * load.
 */
export function refinePack(pack: SitePackV1): RefineResult {
  const issues: PackIssue[] = [];
  const warnings: string[] = [];
  const fail = (path: string, message: string) => issues.push({ path, message });
  const domains = pack.domains;
  // Plain text only (spec 13 §9.10): no terminal escapes or bidi tricks in anything shown.
  issues.push(...unsafeTextIssues(pack));

  // Identity and scope.
  const isRegistrable = (d: string) => registrableDomain(d) === d;
  if (!isRegistrable(pack.id)) fail('id', 'must be a registrable domain');
  if (domains[0] !== pack.id) fail('domains[0]', 'must equal id');
  if (new Set(domains).size !== domains.length) fail('domains', 'must be unique');
  for (const [i, d] of domains.entries()) {
    if (!isRegistrable(d)) fail(`domains[${i}]`, 'must be a registrable domain');
  }
  if (pack.identity_provider !== undefined) {
    if (!isRegistrable(pack.identity_provider))
      fail('identity_provider', 'must be a registrable domain');
    if (pack.identity_provider === pack.id) fail('identity_provider', 'must name another pack');
  }
  for (const [i, d] of pack.shares_login_with.entries()) {
    if (!isRegistrable(d)) fail(`shares_login_with[${i}]`, 'must be a registrable domain');
  }
  if (pack.max_client !== undefined && compareSemver(pack.max_client, pack.min_client) < 0) {
    fail('max_client', 'must not be lower than min_client');
  }

  const inDomains = (host: string) => domains.includes(registrableDomain(host));
  const selector = (path: string, value: string) => {
    const check = checkPackSelector(value);
    if (!check.ok) fail(path, check.reason);
  };
  const glob = (path: string, value: string) => {
    const scope = scopeOfGlob(value, domains);
    if (!scope.ok) fail(path, scope.reason);
    return scope.ok ? scope.value : null;
  };

  // Sign-in.
  if (pack.sign_in === undefined) {
    if (pack.identity_provider === undefined)
      fail('sign_in', 'required unless identity_provider is set');
  } else {
    if (!inDomains(pack.sign_in.url.host)) fail('sign_in.url.host', "outside the pack's domains");
    if (pack.sign_in.form !== undefined) {
      if (pack.sign_in.human_only) fail('sign_in.form', 'refused with human_only');
      for (const [key, value] of Object.entries(pack.sign_in.form)) {
        if (typeof value === 'string') selector(`sign_in.form.${key}`, value);
      }
    }
  }

  // Probe.
  const probe = pack.signed_in;
  if (!inDomains(probe.probe.host)) fail('signed_in.probe.host', "outside the pack's domains");
  if (probe.kind === 'redirect' && probe.signed_out_redirects.length === 0) {
    fail('signed_in.kind', "'redirect' needs signed_out_redirects");
  }
  if (
    probe.kind === 'landmark' &&
    probe.landmark === undefined &&
    probe.signed_out_marker === undefined
  ) {
    fail('signed_in.kind', "'landmark' needs landmark or signed_out_marker");
  }
  if (
    probe.kind === 'either' &&
    probe.signed_out_redirects.length === 0 &&
    probe.landmark === undefined &&
    probe.signed_out_marker === undefined
  ) {
    fail('signed_in.kind', "'either' needs a redirect, a landmark or a signed-out marker");
  }
  for (const [i, g] of probe.signed_out_redirects.entries())
    glob(`signed_in.signed_out_redirects[${i}]`, g);
  if (probe.landmark !== undefined) selector('signed_in.landmark', probe.landmark);
  if (probe.signed_out_marker !== undefined)
    selector('signed_in.signed_out_marker', probe.signed_out_marker);

  // Guards.
  const guardIds = new Map<string, string>();
  for (const [i, guard] of pack.guards.entries()) {
    const at = `guards[${i}]`;
    if (guardIds.has(guard.id)) fail(`${at}.id`, 'duplicate guard id');
    guardIds.set(guard.id, guard.kind);
    glob(`${at}.match.url`, guard.match.url);
    if (guard.action === 'write_policy' && guard.kind !== 'write') {
      fail(`${at}.action`, "'write_policy' only for kind 'write'");
    }
  }
  const elementIds = new Set<string>();
  for (const [i, guard] of pack.element_guards.entries()) {
    const at = `element_guards[${i}]`;
    if (elementIds.has(guard.id)) fail(`${at}.id`, 'duplicate element guard id');
    elementIds.add(guard.id);
    glob(`${at}.page`, guard.page);
    if ('selector' in guard.target) selector(`${at}.target.selector`, guard.target.selector);
    if (guard.action === 'write_policy' && guard.kind !== 'write') {
      fail(`${at}.action`, "'write_policy' only for kind 'write'");
    }
    if (guard.request_guard === undefined) {
      warnings.push(`${at} (${guard.id}) names no request_guard: only the tool path enforces it`);
    } else if (!guardIds.has(guard.request_guard)) {
      fail(`${at}.request_guard`, `no guard '${guard.request_guard}' in this pack`);
    }
  }

  // Challenges.
  const challengeIds = new Set<string>();
  for (const [i, challenge] of pack.challenges.entries()) {
    const at = `challenges[${i}]`;
    if (challengeIds.has(challenge.id)) fail(`${at}.id`, 'duplicate challenge id');
    challengeIds.add(challenge.id);
    const m = challenge.match;
    if (
      m.url === undefined &&
      m.frame === undefined &&
      m.title_contains === undefined &&
      m.landmark === undefined &&
      m.text === undefined
    ) {
      fail(`${at}.match`, 'needs at least one member');
    }
    if (m.url !== undefined) glob(`${at}.match.url`, m.url);
    if (m.landmark !== undefined) selector(`${at}.match.landmark`, m.landmark);
    if (!isAnchoredChallenge(challenge)) {
      warnings.push(
        `${at} (${challenge.id}) matches page text or a landmark without url or title_contains: inert (posted content could match it)`,
      );
    }
  }

  // Pacing.
  const paceIds = new Set<string>();
  for (const [i, rule] of (pack.pacing?.rules ?? []).entries()) {
    const at = `pacing.rules[${i}]`;
    if (paceIds.has(rule.id)) fail(`${at}.id`, 'duplicate rule id');
    paceIds.add(rule.id);
    if (guardIds.get(rule.guard) !== 'write')
      fail(`${at}.guard`, "must name a guard of kind 'write'");
    if (rule.limit > PACE_CEILING[rule.per]) {
      fail(`${at}.limit`, `at most ${PACE_CEILING[rule.per]} per ${rule.per}`);
    }
  }

  // Strategies: each id once, parameters known and well-typed (numbers are clamped when read).
  const strategyIds = new Set<string>();
  for (const [i, strategy] of pack.strategies.entries()) {
    if (strategyIds.has(strategy.id)) fail(`strategies[${i}].id`, 'duplicate strategy');
    strategyIds.add(strategy.id);
    for (const issue of strategyParamIssues(strategy.id, strategy.params)) {
      fail(
        issue.param === null ? `strategies[${i}]` : `strategies[${i}].params.${issue.param}`,
        issue.message,
      );
    }
  }
  if (strategyIds.has('pace-writes') && (pack.pacing?.rules ?? []).length === 0) {
    warnings.push("strategy 'pace-writes' has no pacing rules to apply");
  }

  // The stance rule.
  const policy = pack.write_policy;
  if (policy.default !== STANCE_DEFAULT[policy.stance] && policy.exception === undefined) {
    fail(
      'write_policy.default',
      `the stance '${policy.stance}' asks for '${STANCE_DEFAULT[policy.stance]}' unless 'exception' says why`,
    );
  }

  // Paths BrowserHive loads by itself never match the pack's own protective guards.
  const protective = compileRequestGuardRules(
    pack.guards
      .filter((g) => PROTECTED_KINDS.has(g.kind) && scopeOfGlob(g.match.url, domains).ok)
      .map(
        (g): RequestGuardRuleInput => ({
          id: g.id,
          url: g.match.url,
          ...(g.match.methods === undefined ? {} : { methods: g.match.methods }),
          ...(g.match.resource_types === undefined
            ? {}
            : { resourceTypes: g.match.resource_types }),
          action: 'block',
        }),
      ),
  );
  if (!protective.ok) {
    fail(`guards[${protective.error.index}].match.url`, protective.error.reason);
  } else {
    const loads: [string, string][] = [['signed_in.probe', scopedUrl(probe.probe)]];
    if (pack.keeper?.path !== undefined) {
      loads.push(['keeper.path', scopedUrl({ host: probe.probe.host, path: pack.keeper.path })]);
    }
    for (const [i, strategy] of pack.strategies.entries()) {
      const path = strategy.params['path'];
      if (strategy.id !== 'entry-warmup' || typeof path !== 'string') continue;
      // A malformed path is already an issue (strategyParamIssues).
      if (!/^\/[A-Za-z0-9\-._~/%]*$/.test(path) || path.length > 200) continue;
      loads.push([`strategies[${i}].params.path`, scopedUrl({ host: probe.probe.host, path })]);
      loads.push([`strategies[${i}].params.path`, scopedUrl({ host: `www.${pack.id}`, path })]);
    }
    for (const [path, url] of loads) {
      const hit = matchRequestGuard(protective.value, {
        url,
        method: 'GET',
        resourceType: 'document',
      });
      if (hit !== null) fail(path, `matched by the pack's own guard '${hit.rule.id}'`);
    }
  }

  return { issues, warnings };
}

/** Compares two `MAJOR.MINOR.PATCH[-pre]` versions; a pre-release sorts before its release. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}
