/** @module infra/site-packs/guard-rules — the request guard's rule source for one template host (spec 13 §9.3): the guards of the pack owning a URL's registrable domain, with `write_policy` resolved for the template's site, then `DEFAULT_GUARDS`; compiled once per (pack content, policy, registry generation). */

import type { PackGuard } from '@browserhive/contracts/site-packs';
import {
  compileRequestGuardRules,
  EMPTY_REQUEST_GUARD_RULES,
  type RequestGuardAction,
  type RequestGuardRuleInput,
  type RequestGuardRuleSource,
  type RequestGuardRules,
} from '../../domain/policies/request-guard.ts';
import {
  DEFAULT_GUARDS,
  DEFAULT_GUARDS_ID,
  defaultGuardRuleId,
} from '../../domain/site-packs/default-guards.ts';
import { assertNever } from '../../kernel/errors/app-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { SiteWritePolicy } from '../../ports/persistence/enums.ts';
import type {
  GuardRuleDescriber,
  GuardRuleInfo,
  WritePolicyOverrides,
} from '../../ports/site-guards.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';

/** `DEFAULT_GUARDS` as rule inputs, in their match order. */
export function defaultGuardRuleInputs(): RequestGuardRuleInput[] {
  return DEFAULT_GUARDS.map((g) => ({
    id: defaultGuardRuleId(g.id),
    url: g.url,
    ...(g.methods !== undefined && { methods: g.methods }),
    ...(g.resourceTypes !== undefined && { resourceTypes: g.resourceTypes }),
    action: g.action,
  }));
}

/** The rule action of a write policy. */
export function policyAction(policy: SiteWritePolicy): RequestGuardAction {
  switch (policy) {
    case 'allow':
      return 'allow';
    case 'warn':
      return 'warn';
    case 'confirm':
      return 'confirm';
    default:
      return assertNever(policy, 'write policy');
  }
}

/** A pack guard as a rule input (`<pack id>#<guard id>`, `write_policy` resolved to `policy`). */
export function packGuardRuleInput(
  packId: string,
  guard: PackGuard,
  policy: SiteWritePolicy,
): RequestGuardRuleInput {
  return {
    id: `${packId}#${guard.id}`,
    url: guard.match.url,
    ...(guard.match.methods !== undefined && { methods: guard.match.methods }),
    ...(guard.match.resource_types !== undefined && { resourceTypes: guard.match.resource_types }),
    action: guard.action === 'write_policy' ? policyAction(policy) : guard.action,
  };
}

/**
 * What every rule id means: the rule sources remember each compiled pack's guards here, so a hit
 * or a confirmation names its pack, guard and kind even after the registry moved on. One per
 * process, shared by every template host.
 */
export class GuardRuleCatalog {
  readonly #byId = new Map<string, GuardRuleInfo>();

  constructor() {
    for (const g of DEFAULT_GUARDS) {
      this.#remember({
        ruleId: defaultGuardRuleId(g.id),
        packId: DEFAULT_GUARDS_ID,
        guardId: g.id,
        guardKind: g.kind,
        siteTitle: g.title,
      });
    }
  }

  /** Remembers the guards of a pack version (the newest compiled version of a pack wins). */
  rememberPack(pack: EffectivePack): void {
    for (const guard of pack.pack.guards) {
      this.#remember({
        ruleId: `${pack.packId}#${guard.id}`,
        packId: pack.packId,
        guardId: guard.id,
        guardKind: guard.kind,
        siteTitle: pack.pack.title,
      });
    }
  }

  /** The meaning of a rule id, `null` for one no rule source produced. */
  readonly describe: GuardRuleDescriber = (ruleId) => this.#byId.get(ruleId) ?? null;

  #remember(info: GuardRuleInfo): void {
    this.#byId.set(info.ruleId, info);
  }
}

/** Collaborators of {@link PackGuardRuleSource}. */
export interface PackGuardRuleSourceDeps {
  /** The template host the source serves (its sites' write-policy overrides). */
  readonly templateId: string;
  readonly lookup: SitePackLookup;
  readonly overrides: WritePolicyOverrides;
  readonly catalog: GuardRuleCatalog;
  readonly logger: Logger;
}

/**
 * The rules of one template host. `rulesFor(url)`: the guards of the approved, enabled pack whose
 * domains contain the URL's registrable domain, `write_policy` resolved from the template site's
 * override (else the pack default), followed by `DEFAULT_GUARDS`; a URL outside every pack gets
 * `DEFAULT_GUARDS` only. Compiled sets are cached per (pack SHA-256, policy) and dropped when the
 * registry's generation changes. A pack whose guards do not compile is logged once per content and
 * policy and contributes nothing (the request guard never throws for it); `DEFAULT_GUARDS` still
 * apply.
 */
export class PackGuardRuleSource implements RequestGuardRuleSource {
  readonly #deps: PackGuardRuleSourceDeps;
  readonly #log: Logger;
  readonly #defaults: RequestGuardRules;
  readonly #cache = new Map<string, RequestGuardRules>();
  #generation: number;

  constructor(deps: PackGuardRuleSourceDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.guards', templateId: deps.templateId });
    this.#generation = deps.lookup.generation;
    this.#defaults = this.#compile('browserhive', defaultGuardRuleInputs());
  }

  rulesFor(url: string): RequestGuardRules {
    const host = hostOf(url);
    if (host === null) return this.#defaults;
    const pack = this.#deps.lookup.effectiveFor(host);
    if (pack === null) return this.#defaults;
    const generation = this.#deps.lookup.generation;
    if (generation !== this.#generation) {
      this.#cache.clear();
      this.#generation = generation;
    }
    const policy =
      this.#deps.overrides.overrideFor(this.#deps.templateId, {
        id: pack.packId,
        domains: pack.pack.domains,
      }) ?? pack.pack.write_policy.default;
    const key = `${pack.sha256}\u0000${policy}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    this.#deps.catalog.rememberPack(pack);
    const inputs = pack.pack.guards.map((g) => packGuardRuleInput(pack.packId, g, policy));
    const own = compileRequestGuardRules(inputs);
    let rules: RequestGuardRules;
    if (own.ok) {
      rules = { rules: [...own.value.rules, ...this.#defaults.rules] };
    } else {
      this.#log.warn('pack guards skipped', {
        packId: pack.packId,
        version: pack.version,
        rule: own.error.id,
        reason: own.error.reason,
      });
      rules = this.#defaults;
    }
    this.#cache.set(key, rules);
    return rules;
  }

  #compile(label: string, inputs: readonly RequestGuardRuleInput[]): RequestGuardRules {
    const compiled = compileRequestGuardRules(inputs);
    if (compiled.ok) return compiled.value;
    this.#log.error('default guards invalid', {
      set: label,
      rule: compiled.error.id,
      reason: compiled.error.reason,
    });
    return EMPTY_REQUEST_GUARD_RULES;
  }
}

/** The URL's host for `http(s)` URLs; `null` otherwise. */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.length > 0 ? parsed.hostname : null;
  } catch {
    return null;
  }
}
