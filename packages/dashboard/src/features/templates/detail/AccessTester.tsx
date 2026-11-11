/** @module features/templates/detail/AccessTester — "Would this agent be allowed?": a principal and a harness (the same names as the harness picker, or a declared custom name) checked against the saved rule by the server (`POST /templates/{id}/access/resolve`, the D-48 tester) */
import { harnessLabel } from '@browserhive/contracts/harness';
import { type FormEvent, useId, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { PICKABLE_HARNESSES } from '@/features/vault/harnesses/harness-rule.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { useTemplateOperations } from '../api-operations.ts';

const REASON: Readonly<Record<string, string>> = {
  principal_not_allowed: 'This agent is not on the list of who may use it.',
  harness_not_allowed: 'The harness rule does not allow this harness.',
  recording: 'The template is still being set up: no agent can use it until the sign-in finishes.',
};

/** "Any" (no harness checked), the known harnesses, then a custom declared name. */
const ANY = '';
const CUSTOM = 'custom';

/** Tester. */
export function AccessTester({ templateId }: { readonly templateId: string }) {
  const ops = useTemplateOperations(templateId);
  const [principal, setPrincipal] = useState('');
  const [harness, setHarness] = useState(ANY);
  const [declared, setDeclared] = useState('');
  const principalId = useId();
  const harnessId = useId();
  const declaredId = useId();
  const result = ops.resolveAccess.data;
  const error = ops.resolveAccess.error;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    ops.resolveAccess.mutate({
      ...(principal.trim() !== '' && { principal: principal.trim() }),
      ...(harness !== ANY && harness !== CUSTOM && { harness }),
      ...(harness === CUSTOM && declared.trim() !== '' && { harness_declared: declared.trim() }),
    });
  };
  return (
    <Panel title="Check an agent" description="Tests the saved rule, not unsaved changes.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={principalId}>Agent (token subject)</Label>
            <Input
              id={principalId}
              size="sm"
              className="font-mono"
              placeholder="agent:research"
              autoComplete="off"
              spellCheck={false}
              value={principal}
              onChange={(event) => setPrincipal(event.target.value)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={harnessId}>Harness</Label>
            <SimpleSelect
              id={harnessId}
              size="sm"
              value={harness}
              onValueChange={setHarness}
              options={[
                { value: ANY, label: 'Don’t check the harness' },
                ...PICKABLE_HARNESSES.map((slug) => ({ value: slug, label: harnessLabel(slug) })),
                { value: 'unknown', label: 'Unknown' },
                { value: CUSTOM, label: 'Custom name…' },
              ]}
            />
          </div>
          {harness === CUSTOM ? (
            <div className="flex min-w-0 flex-col gap-1.5 sm:col-start-2">
              <Label htmlFor={declaredId}>Declared name</Label>
              <Input
                id={declaredId}
                size="sm"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                value={declared}
                onChange={(event) => setDeclared(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" variant="outline" disabled={ops.resolveAccess.isPending}>
            {ops.resolveAccess.isPending ? <Spinner /> : null}
            Check
          </Button>
        </div>
        {result !== undefined ? (
          <Callout
            tone={result.allowed ? 'success' : 'warn'}
            title={result.allowed ? 'Allowed' : 'Not allowed'}
          >
            {result.allowed
              ? `This agent can list and launch the template.${result.harness_list_unchecked ? ' The harness was not checked.' : ''}`
              : (REASON[result.reason ?? ''] ?? 'The rule refuses this agent.')}
          </Callout>
        ) : null}
        {error !== null ? (
          <Callout tone="warn" title="Couldn’t check">
            {toAppError(error).message}
          </Callout>
        ) : null}
      </form>
    </Panel>
  );
}
