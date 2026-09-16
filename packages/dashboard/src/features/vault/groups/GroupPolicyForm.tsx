/** @module features/vault/groups/GroupPolicyForm — one group's policy form (react-hook-form): access mode (confirm before reject_all), allow_all_sessions, slug globs, flags; saves with `If-Match` (spec 04 §12.7) */
import type { VaultAccessMode, VaultGroup } from '@browserhive/contracts/http';
import { PutGroupPolicyRequest } from '@browserhive/contracts/http';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { usePutGroupPolicy } from '../api.ts';
import { parseLines } from '../bindings/binding-form.ts';
import { FlagField, FormRow } from '../bindings/FlagField.tsx';

interface PolicyForm {
  access_mode: VaultAccessMode;
  allow_all_sessions: boolean;
  session_slug_globs: string;
  dashboard_confirm: boolean;
  require_no_evaluate: boolean;
  redact_username: boolean;
}

function toForm(group: VaultGroup): PolicyForm {
  const p = group.policy;
  return {
    access_mode: p?.access_mode ?? 'manual',
    allow_all_sessions: p?.allow_all_sessions ?? false,
    session_slug_globs: (p?.session_slug_globs ?? []).join('\n'),
    dashboard_confirm: p?.dashboard_confirm ?? false,
    require_no_evaluate: p?.require_no_evaluate ?? false,
    redact_username: p?.redact_username ?? false,
  };
}

/** Group policy form. */
export function GroupPolicyForm({ group }: { readonly group: VaultGroup }) {
  const confirm = useConfirm();
  const put = usePutGroupPolicy();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<PolicyForm>({ defaultValues: toForm(group) });
  const updatedAt = group.policy?.updated_at;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync only when the stored policy changes underneath
  useEffect(() => form.reset(toForm(group)), [updatedAt]);
  const mode = form.watch('access_mode');
  const allowAll = form.watch('allow_all_sessions');
  const submit = form.handleSubmit(async (values) => {
    setSaved(false);
    setError(null);
    if (values.access_mode === 'reject_all' && group.policy?.access_mode !== 'reject_all') {
      const ok = await confirm({
        title: `Reject every fill in ${group.name}?`,
        description:
          'No item in this group can be filled until the policy changes, whatever its bindings say.',
        confirmLabel: 'Reject all',
        danger: true,
      });
      if (!ok) return;
    }
    const body = {
      access_mode: values.access_mode,
      allow_all_sessions: values.allow_all_sessions,
      session_slug_globs: values.allow_all_sessions ? [] : parseLines(values.session_slug_globs),
      dashboard_confirm: values.dashboard_confirm,
      require_no_evaluate: values.require_no_evaluate,
      redact_username: values.redact_username,
    };
    const parsed = PutGroupPolicyRequest.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid policy.');
      return;
    }
    put.mutate(
      { groupId: group.group_id, version: group.policy?.version ?? null, body: parsed.data },
      { onSuccess: () => setSaved(true) },
    );
  });
  return (
    <form
      className="flex max-w-2xl flex-col gap-3"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <FormRow label="Access mode">
        {(id, describedBy) => (
          <SimpleSelect
            id={id}
            aria-describedby={describedBy}
            className="w-fit"
            value={mode}
            options={[
              { value: 'manual', label: 'Manual binding' },
              { value: 'allow_all', label: 'Allow all' },
              { value: 'reject_all', label: 'Reject all' },
            ]}
            onValueChange={(value) => {
              if (value === 'manual' || value === 'allow_all' || value === 'reject_all') {
                form.setValue('access_mode', value, { shouldDirty: true });
              }
            }}
          />
        )}
      </FormRow>
      {mode === 'reject_all' ? (
        <Callout tone="danger" title="Group blocked">
          Every fill of an item in <span className="font-mono">{group.name}</span> is rejected.
        </Callout>
      ) : null}
      {mode === 'allow_all' ? (
        <Callout tone="vault" title="Every item fillable on its own saved URLs">
          Any item in <span className="font-mono">{group.name}</span> may be filled by an authorized
          session, but only on the origins derived from that item's saved login URIs. Items with no
          saved URL are not fillable.
        </Callout>
      ) : null}
      <FlagField
        control={form.control}
        name="allow_all_sessions"
        hint="any session slug may request these items"
      />
      <FormRow
        label="Authorized session slug globs"
        hint="One per line — exact slug or * glob. Ignored when allow_all_sessions is on."
      >
        {(id, describedBy) => (
          <Textarea
            id={id}
            rows={2}
            className="font-mono"
            disabled={allowAll}
            aria-describedby={describedBy}
            {...form.register('session_slug_globs')}
          />
        )}
      </FormRow>
      <FlagField
        control={form.control}
        name="dashboard_confirm"
        hint="intercept every fill in this group and require the operator to approve/deny it here"
      />
      <FlagField
        control={form.control}
        name="require_no_evaluate"
        hint="every item in this group refuses to fill while evaluate is enabled for the session"
      />
      <FlagField
        control={form.control}
        name="redact_username"
        hint="also add the username (not just the password) to the redaction window on each fill"
      />
      {error !== null ? (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={put.isPending}>
          {put.isPending ? 'Saving…' : 'Save group policy'}
        </Button>
        {saved ? <Chip tone="vault">saved</Chip> : null}
        {group.policy !== null ? (
          <span className="font-mono text-sm text-muted-foreground">v{group.policy.version}</span>
        ) : null}
      </div>
    </form>
  );
}
