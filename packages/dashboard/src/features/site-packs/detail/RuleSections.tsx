/** @module features/site-packs/detail/RuleSections — a pack's guards, guarded controls and security checks as tables of text (spec 13 §9.3, §9.5): each guard's kind, address pattern, methods and resource types (or their defaults) and action (or that the pack has none); each guarded control's page, selector or role and name, action and the guard that enforces it on the network; each check's kind, what it matches and what it does */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { Plain } from '@/components/shared/Plain.tsx';
import {
  CHALLENGE_ACTION_LABEL,
  CHALLENGE_KIND_LABEL,
  GUARD_ACTION_LABEL,
  GUARD_KIND_LABEL,
} from './labels.ts';
import { Code, PackSection, RuleTable } from './PackSection.tsx';

/** Network guards. */
export function GuardsSection({ pack }: { readonly pack: SitePackV1 }) {
  if (pack.guards.length === 0)
    return (
      <PackSection title="Guards (0)" docs="sitePacksGuards">
        <p className="text-base text-muted-foreground">
          No guards: nothing on <Plain>{pack.domains.join(', ')}</Plain> is blocked, held or
          flagged.
        </p>
      </PackSection>
    );
  return (
    <PackSection
      title={`Guards (${pack.guards.length})`}
      docs="sitePacksGuards"
      description="Requests to these addresses are blocked, held for your approval or flagged, whichever page sends them. Write policy means the template site’s write policy decides."
    >
      <RuleTable label="Guards" head={['Guard', 'Matches', 'Action']}>
        {pack.guards.map((g) => (
          <tr key={g.id}>
            <td>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{GUARD_KIND_LABEL[g.kind]}</span>
                <span className="font-mono text-xs text-muted-foreground">{g.id}</span>
              </span>
            </td>
            <td>
              <span className="flex flex-col gap-1">
                <Code>{g.match.url}</Code>
                <span className="text-xs text-muted-foreground">
                  {g.match.methods?.join(', ') ?? 'Every method'} ·{' '}
                  {g.match.resource_types?.join(', ') ?? 'document, xhr, fetch, ping'}
                </span>
              </span>
            </td>
            <td className="whitespace-nowrap">{GUARD_ACTION_LABEL[g.action]}</td>
          </tr>
        ))}
      </RuleTable>
    </PackSection>
  );
}

/** Element guards. */
export function ElementGuardsSection({ pack }: { readonly pack: SitePackV1 }) {
  if (pack.element_guards.length === 0) return null;
  return (
    <PackSection
      title={`Guarded controls (${pack.element_guards.length})`}
      description="An agent’s click, typing or key press on these controls is refused or held before the browser is touched."
    >
      <RuleTable label="Guarded controls" head={['Control', 'Where', 'Action']}>
        {pack.element_guards.map((g) => (
          <tr key={g.id}>
            <td>
              <span className="flex flex-col gap-1">
                <span className="font-medium">{GUARD_KIND_LABEL[g.kind]}</span>
                {'selector' in g.target ? (
                  <Code>{g.target.selector}</Code>
                ) : (
                  <span>
                    {g.target.role} named “<Plain>{g.target.name}</Plain>”
                  </span>
                )}
                <span className="font-mono text-xs text-muted-foreground">{g.id}</span>
              </span>
            </td>
            <td>
              <span className="flex flex-col gap-1">
                <Code>{g.page}</Code>
                {g.request_guard !== undefined ? (
                  <span className="text-xs text-muted-foreground">
                    Enforced on the network by <span className="font-mono">{g.request_guard}</span>
                  </span>
                ) : null}
              </span>
            </td>
            <td className="whitespace-nowrap">{GUARD_ACTION_LABEL[g.action]}</td>
          </tr>
        ))}
      </RuleTable>
    </PackSection>
  );
}

/** What a challenge matches, in words. */
function matchParts(match: SitePackV1['challenges'][number]['match']): readonly string[] {
  return [
    match.url === undefined ? null : `Address ${match.url}`,
    match.frame === undefined ? null : `A ${match.frame} challenge frame`,
    match.title_contains === undefined ? null : `Title contains “${match.title_contains}”`,
    match.landmark === undefined ? null : `Element ${match.landmark}`,
    match.text === undefined ? null : `Text “${match.text}”`,
  ].filter((s): s is string => s !== null);
}

/** Challenges. */
export function ChallengesSection({ pack }: { readonly pack: SitePackV1 }) {
  if (pack.challenges.length === 0) return null;
  return (
    <PackSection
      title={`Security checks (${pack.challenges.length})`}
      docs="sitePacksChallenges"
      description="Pages that need a person. The agent’s session waits while you clear them on Attention."
    >
      <RuleTable label="Security checks" head={['Check', 'Matches', 'Then']}>
        {pack.challenges.map((c) => (
          <tr key={c.id}>
            <td>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{CHALLENGE_KIND_LABEL[c.kind]}</span>
                <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
              </span>
            </td>
            <td>
              <ul className="flex flex-col gap-0.5">
                {matchParts(c.match).map((part) => (
                  <li key={part}>
                    <Plain>{part}</Plain>
                  </li>
                ))}
              </ul>
            </td>
            <td>{CHALLENGE_ACTION_LABEL[c.action]}</td>
          </tr>
        ))}
      </RuleTable>
    </PackSection>
  );
}
