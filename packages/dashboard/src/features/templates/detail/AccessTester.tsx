/** @module features/templates/detail/AccessTester — "Would this agent be allowed?": a principal and a harness name checked against the saved rule by the server (`POST /templates/{id}/access/resolve`, the D-48 tester) */
import { type FormEvent, useId, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useTemplateOperations } from '../api-operations.ts';
import { isRouteMissing } from '../pending/client.ts';

const REASON: Readonly<Record<string, string>> = {
  principal_not_allowed: 'This principal is not on the list of who may use it.',
  harness_not_allowed: 'This harness is not allowed by the harness rule.',
};

/** Tester. */
export function AccessTester({ templateId }: { readonly templateId: string }) {
  const ops = useTemplateOperations(templateId);
  const [principal, setPrincipal] = useState('');
  const [harness, setHarness] = useState('');
  const principalId = useId();
  const harnessId = useId();
  const result = ops.resolveAccess.data;
  const error = ops.resolveAccess.error;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    ops.resolveAccess.mutate({
      ...(principal.trim() !== '' && { principal: principal.trim() }),
      ...(harness.trim() !== '' && { harness: harness.trim() }),
    });
  };
  return (
    <Panel title="Check an agent" description="Tests the saved rule, not unsaved changes.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={principalId}>Principal</Label>
            <Input
              id={principalId}
              size="sm"
              className="font-mono"
              placeholder="agent:claude"
              autoComplete="off"
              spellCheck={false}
              value={principal}
              onChange={(event) => setPrincipal(event.target.value)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={harnessId}>Harness</Label>
            <Input
              id={harnessId}
              size="sm"
              className="font-mono"
              placeholder="claude-code"
              autoComplete="off"
              spellCheck={false}
              value={harness}
              onChange={(event) => setHarness(event.target.value)}
            />
          </div>
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
              ? 'This agent can list and launch the template.'
              : (REASON[result.reason ?? ''] ?? 'The rule refuses this agent.')}
          </Callout>
        ) : null}
        {error !== null ? (
          <Callout tone="warn" title="Couldn’t check">
            {isRouteMissing(error)
              ? 'This server can’t test template access yet.'
              : toAppError(error).message}
          </Callout>
        ) : null}
      </form>
    </Panel>
  );
}
