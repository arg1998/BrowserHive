/** @module features/templates/wizard/StepAccess — step 4 (spec 13 §7.1, §6.1, §5.4): who may use the template (every agent, or the listed principals; an explicit choice under `auth=token`), the harnesses (D-48's field), the session cap, and the sealing: every sign-in protected by default, each "Allow …" confirmed with its editor text and optionally limited to some principals */
import type { AuthMode } from '@browserhive/contracts/enums';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useVaultHarnesses } from '@/features/vault/api.ts';
import { HarnessRuleField } from '@/features/vault/harnesses/HarnessRuleField.tsx';
import { unsealConfirm } from '../confirm-copy.ts';
import { Field, PrincipalsInput } from '../fields.tsx';
import { UNSEAL_FLAGS, UNSEAL_TEXT, type UnsealFlag } from '../unseal.ts';
import { useAgentPrincipals } from '../use-agent-principals.ts';
import { WhoMayUse } from '../WhoMayUse.tsx';
import type { TemplateDraft } from './draft.ts';

/** Step 4. */
export function StepAccess({
  draft,
  onDraft,
  errors,
  authMode,
  vaultEnabled,
}: {
  readonly draft: TemplateDraft;
  readonly onDraft: (update: (d: TemplateDraft) => TemplateDraft) => void;
  readonly errors: Readonly<Record<string, string>>;
  readonly authMode: AuthMode | null;
  readonly vaultEnabled: boolean;
}) {
  const confirm = useConfirm();
  const token = authMode === 'token';
  const suggestions = useAgentPrincipals(token);
  const harnesses = useVaultHarnesses(vaultEnabled);
  const toggleUnseal = async (flag: UnsealFlag, on: boolean) => {
    if (on && !(await confirm(unsealConfirm(UNSEAL_TEXT[flag].short, UNSEAL_TEXT[flag].text))))
      return;
    onDraft((d) => ({ ...d, unseal: { ...d.unseal, [flag]: on } }));
  };
  const anyUnsealed = UNSEAL_FLAGS.some((f) => draft.unseal[f]);
  return (
    <div className="flex max-w-3xl flex-col gap-7">
      <WhoMayUse
        authMode={authMode}
        choice={draft.access ?? (token ? null : 'all')}
        principals={draft.principals}
        onChoice={(access) => onDraft((d) => ({ ...d, access }))}
        onPrincipals={(principals) => onDraft((d) => ({ ...d, principals }))}
        error={errors['principals']}
        choiceError={errors['access']}
      />

      <HarnessRuleField
        value={draft.harnesses}
        onChange={(next) => onDraft((d) => ({ ...d, harnesses: next }))}
        noun="template"
        seen={harnesses.data}
      />

      <Field
        label="Sessions at once"
        htmlFor="access-cap"
        error={errors['maxConcurrent']}
        help="Agent sessions that may run from this template together, 1–20. Each is a window of the same browser."
      >
        <Input
          id="access-cap"
          type="number"
          inputMode="numeric"
          min={1}
          max={20}
          value={String(draft.maxConcurrent)}
          className="w-24 tabular-nums"
          onChange={(event) =>
            onDraft((d) => ({ ...d, maxConcurrent: Number.parseInt(event.target.value, 10) || 0 }))
          }
        />
      </Field>

      <section aria-labelledby="access-sealing" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 id="access-sealing" className="text-base font-semibold">
            Sign-ins protected
          </h3>
          <p className="text-sm text-pretty text-muted-foreground">
            Agents act as the account but never receive its cookie values or a copy of the sign-in.
            Allow only what a trusted agent needs.
          </p>
        </div>
        <ul className="flex flex-col divide-y rounded-lg border">
          {UNSEAL_FLAGS.map((flag) => (
            <li key={flag} className="flex items-start gap-3 px-4 py-3">
              <Checkbox
                id={`unseal-${flag}`}
                className="mt-1"
                checked={draft.unseal[flag]}
                onCheckedChange={(on) => void toggleUnseal(flag, on)}
                aria-describedby={`unseal-${flag}-text`}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <label htmlFor={`unseal-${flag}`} className="cursor-pointer text-base font-medium">
                  {UNSEAL_TEXT[flag].label}
                </label>
                <span
                  id={`unseal-${flag}-text`}
                  className="text-sm text-pretty text-muted-foreground"
                >
                  {UNSEAL_TEXT[flag].text}
                </span>
              </span>
            </li>
          ))}
        </ul>
        {anyUnsealed ? (
          <Field
            label="Applies to"
            help="Empty: every agent allowed above. Otherwise only these agents’ sessions are unprotected."
          >
            <PrincipalsInput
              label="Unprotected for"
              value={draft.unsealPrincipals}
              suggestions={suggestions}
              onChange={(unsealPrincipals) => onDraft((d) => ({ ...d, unsealPrincipals }))}
            />
          </Field>
        ) : null}
      </section>
    </div>
  );
}
