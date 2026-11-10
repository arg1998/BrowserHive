/** @module features/templates/WhoMayUse — "Who may use it" (spec 13 §6.1) for the wizard and the Access tab: under `auth=token` an explicit All agents / Only these agents choice with the principals typed (agent tokens suggested); with authentication off, every agent is the one local principal, so it only says so */
import type { AuthMode } from '@browserhive/contracts/enums';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { PrincipalsInput } from './fields.tsx';
import { useAgentPrincipals } from './use-agent-principals.ts';

/** `all`, `listed`, or `null` (not chosen yet; only before a template exists). */
export type WhoChoice = 'all' | 'listed' | null;

/** The section. */
export function WhoMayUse({
  authMode,
  choice,
  principals,
  onChoice,
  onPrincipals,
  error,
  choiceError,
  headingLevel = 3,
}: {
  readonly authMode: AuthMode | null;
  readonly choice: WhoChoice;
  readonly principals: readonly string[];
  readonly onChoice: (choice: 'all' | 'listed') => void;
  readonly onPrincipals: (principals: string[]) => void;
  readonly error?: string | undefined;
  readonly choiceError?: string | undefined;
  /** 2 on the template page (directly under the page title), 3 inside the wizard's step. */
  readonly headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const token = authMode === 'token';
  const suggestions = useAgentPrincipals(token);
  // With authentication off, only a list naming someone other than `local` needs editing.
  const named = principals.filter((p) => p !== 'local');
  const editable = token || named.length > 0;
  return (
    <section aria-labelledby="who-may-use" className="flex flex-col gap-3">
      <Heading id="who-may-use" className="text-base font-semibold">
        Who may use it
      </Heading>
      {editable ? (
        <ToggleGroup
          aria-labelledby="who-may-use"
          size="sm"
          spacing={0}
          value={choice === null ? [] : [choice]}
          onValueChange={(value: readonly string[]) => {
            const next = value[0];
            if (next === 'all' || next === 'listed') onChoice(next);
          }}
          className="self-start"
        >
          <ToggleGroupItem value="all">All agents</ToggleGroupItem>
          <ToggleGroupItem value="listed">Only these agents</ToggleGroupItem>
        </ToggleGroup>
      ) : null}
      {choiceError !== undefined ? (
        <p role="alert" className="text-sm text-danger-text">
          {choiceError}
        </p>
      ) : null}
      <p className="text-sm text-pretty text-muted-foreground">
        {token
          ? 'Agents are told apart by their API token. With All agents, every token can launch sessions from this sign-in. Agents not allowed don’t see the template at all.'
          : 'Every agent of this hive. Authentication is off, so all agents connect as the same local principal; run with auth=token to tell them apart.'}
      </p>
      {editable && choice === 'listed' ? (
        <PrincipalsInput
          label="Allowed agents"
          value={token ? principals : named}
          suggestions={suggestions}
          error={error}
          onChange={onPrincipals}
        />
      ) : null}
    </section>
  );
}
