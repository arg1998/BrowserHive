/** @module features/templates/detail/AccessTab — the Access tab (spec 13 §6, §5.4, §11.4): who may use the template, the Harnesses field (D-48, reused from the vault), the session cap, and sealing ("Sign-ins protected": each Allow … switch with its editor text and the principals it applies to); a local draft saved with If-Match, confirming unseal flags and changes that can close live sessions; the access tester */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { useId, useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { useVaultEnabled } from '@/features/sessions/api.ts';
import { useSystem } from '@/features/system/api.ts';
import { useVaultHarnesses } from '@/features/vault/api.ts';
import { HarnessRuleField } from '@/features/vault/harnesses/HarnessRuleField.tsx';
import { cn } from '@/lib/utils.ts';
import { useTemplateOperations } from '../api-operations.ts';
import { accessChangeConfirm, unsealConfirm } from '../confirm-copy.ts';
import { PrincipalsInput } from '../fields.tsx';
import { useAgentPrincipals } from '../use-agent-principals.ts';
import { useLiveSessionLines } from '../use-template-actions.ts';
import { WhoMayUse } from '../WhoMayUse.tsx';
import { AccessTester } from './AccessTester.tsx';
import {
  type AccessDraft,
  draftOf,
  isDirty,
  narrowsAccess,
  patchOf,
  UNSEAL_FLAGS,
  UNSEAL_TEXT,
  type UnsealFlag,
} from './access-draft.ts';

const CAP = { min: 1, max: 20 } as const;

function UnsealSwitch({
  flag,
  on,
  onChange,
}: {
  readonly flag: UnsealFlag;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const id = useId();
  const textId = useId();
  return (
    <div className="flex items-start gap-3 py-3 first:pt-0">
      <Switch
        id={id}
        checked={on}
        aria-describedby={textId}
        onCheckedChange={onChange}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-base font-medium">
          {UNSEAL_TEXT[flag].label}
        </label>
        <p id={textId} className="max-w-2xl text-sm text-pretty text-muted-foreground">
          {UNSEAL_TEXT[flag].text}
        </p>
      </div>
    </div>
  );
}

/** Access tab. */
export function AccessTab({ detail }: { readonly detail: TemplateDetailResponse }) {
  const { template } = detail;
  const policy = template.policy;
  const ops = useTemplateOperations(template.template_id);
  const confirm = useConfirm();
  const toast = useToast();
  const liveLines = useLiveSessionLines();
  const vault = useVaultEnabled();
  const seen = useVaultHarnesses(vault === true);
  const capId = useId();
  const authMode = useSystem().data?.auth_mode ?? null;
  const suggestions = useAgentPrincipals(authMode === 'token');
  const [listing, setListing] = useState(false);
  // The draft follows the stored policy until the operator edits; a server change resets it.
  const [edit, setEdit] = useState<{ readonly base: number; readonly draft: AccessDraft } | null>(
    null,
  );
  const draft = edit !== null && edit.base === template.version ? edit.draft : draftOf(policy);
  const set = (patch: Partial<AccessDraft>) =>
    setEdit({ base: template.version, draft: { ...draft, ...patch } });
  const dirty = isDirty(draft, policy);
  const capValid =
    Number.isInteger(draft.maxConcurrent) &&
    draft.maxConcurrent >= CAP.min &&
    draft.maxConcurrent <= CAP.max;
  const sealed = UNSEAL_FLAGS.every((f) => !draft.unseal[f]);

  const toggleFlag = async (flag: UnsealFlag, on: boolean) => {
    if (on && !(await confirm(unsealConfirm(UNSEAL_TEXT[flag].short, UNSEAL_TEXT[flag].text))))
      return;
    set({ unseal: { ...draft.unseal, [flag]: on } });
  };
  const save = async () => {
    if (narrowsAccess(draft, policy)) {
      const lines = await liveLines(template.template_id);
      if (lines.length > 0 && !(await confirm(accessChangeConfirm(lines)))) return;
    }
    try {
      const result = await ops.patch.mutateAsync({
        patch: patchOf(draft, policy),
        ifMatch: template.version,
      });
      setEdit(null);
      toast.success({
        title: 'Access saved',
        ...(result.closed_sessions.length > 0 && {
          description: `${result.closed_sessions.length} session${result.closed_sessions.length === 1 ? '' : 's'} closed.`,
        }),
      });
    } catch {
      // The mutation's toast carries the code (a stale If-Match reads CONFLICT).
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel>
        <div className="flex flex-col gap-6">
          <WhoMayUse
            headingLevel={2}
            authMode={authMode}
            choice={listing || draft.principals.some((p) => p !== 'local') ? 'listed' : 'all'}
            principals={draft.principals}
            onChoice={(choice) => {
              setListing(choice === 'listed');
              if (choice === 'all') set({ principals: [] });
            }}
            onPrincipals={(principals) => set({ principals })}
          />
          <HarnessRuleField
            noun="template"
            value={draft.harnesses}
            onChange={(harnesses) => set({ harnesses })}
            seen={seen.data}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={capId}>Sessions at once</Label>
            <Input
              id={capId}
              type="number"
              inputMode="numeric"
              min={CAP.min}
              max={CAP.max}
              size="sm"
              className="w-24"
              aria-invalid={!capValid}
              value={Number.isNaN(draft.maxConcurrent) ? '' : String(draft.maxConcurrent)}
              onChange={(event) => set({ maxConcurrent: Number.parseInt(event.target.value, 10) })}
            />
            <p className={capValid ? 'text-sm text-muted-foreground' : 'text-sm text-danger-text'}>
              {capValid
                ? 'Launches beyond this wait for a session to close.'
                : `Between ${CAP.min} and ${CAP.max}.`}
            </p>
          </div>
        </div>
      </Panel>
      <Panel
        title={
          <span className="flex items-center gap-2">
            Sign-ins protected
            {sealed ? <Chip tone="success">On</Chip> : <Chip tone="warn">Partly off</Chip>}
          </span>
        }
        description="Agents act as the account but never receive its cookie values or storage. It does not stop an agent from creating its own credentials on a site."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col divide-y">
            {UNSEAL_FLAGS.map((flag) => (
              <UnsealSwitch
                key={flag}
                flag={flag}
                on={draft.unseal[flag]}
                onChange={(on) => void toggleFlag(flag, on)}
              />
            ))}
          </div>
          {!sealed ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-base font-medium">These allowances apply to</span>
              <span className="text-sm text-muted-foreground">
                Empty: every agent that may use the template. Otherwise every other agent stays
                protected.
              </span>
              <PrincipalsInput
                label="Unprotected for"
                value={draft.unsealPrincipals}
                suggestions={suggestions}
                onChange={(unsealPrincipals) => set({ unsealPrincipals })}
              />
            </div>
          ) : null}
        </div>
      </Panel>
      <div
        className={cn(
          'flex flex-wrap items-center justify-end gap-2 rounded-xl border bg-card/95 px-4 py-3 backdrop-blur',
          // Only unsaved changes keep the bar in view; otherwise it stays in place under the form.
          dirty && 'sticky bottom-4 z-(--z-sticky) shadow-sm dark:shadow-none',
        )}
      >
        <span className="mr-auto text-sm text-muted-foreground">
          {dirty ? 'Unsaved changes' : 'No unsaved changes'}
        </span>
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || ops.patch.isPending}
          onClick={() => setEdit(null)}
        >
          Reset
        </Button>
        <Button
          type="button"
          disabled={!dirty || !capValid || ops.patch.isPending}
          onClick={() => void save()}
        >
          {ops.patch.isPending ? <Spinner /> : null}
          Save access
        </Button>
      </div>
      <AccessTester templateId={template.template_id} />
    </div>
  );
}
