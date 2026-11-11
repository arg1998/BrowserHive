/** @module features/templates/wizard/StepName — step 1 (spec 13 §7.1): the display name, the name agents use (suggested from the display name until typed, checked against the agent-facing grammar as you type) and the description agents read in `list_templates` */
import { useId } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Field } from '../fields.tsx';
import { suggestName } from '../model.ts';
import type { TemplateDraft } from './draft.ts';

/** Step 1. */
export function StepName({
  draft,
  onDraft,
  errors,
}: {
  readonly draft: TemplateDraft;
  readonly onDraft: (update: (d: TemplateDraft) => TemplateDraft) => void;
  readonly errors: Readonly<Record<string, string>>;
}) {
  const displayId = useId();
  const nameId = useId();
  const descriptionId = useId();
  return (
    <div className="flex max-w-xl flex-col gap-5">
      <Field
        label="Display name"
        htmlFor={displayId}
        optional
        help="Shown here in the dashboard."
        error={errors['displayName']}
      >
        <Input
          id={displayId}
          value={draft.displayName}
          maxLength={80}
          placeholder="Job hunt"
          autoComplete="off"
          onChange={(event) => {
            const displayName = event.target.value;
            onDraft((d) => ({
              ...d,
              displayName,
              ...(!d.nameTouched && { name: suggestName(displayName) }),
            }));
          }}
        />
      </Field>
      <Field
        label="Name for agents"
        htmlFor={nameId}
        help={
          <>
            Agents ask for the template by this name. Lowercase letters, digits and dashes,{' '}
            <span className="whitespace-nowrap">2–32 characters</span>.
          </>
        }
        error={errors['name']}
      >
        <Input
          id={nameId}
          value={draft.name}
          maxLength={32}
          placeholder="job-hunt"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          className="max-w-xs font-mono"
          aria-invalid={errors['name'] !== undefined ? true : undefined}
          onChange={(event) =>
            onDraft((d) => ({ ...d, name: event.target.value.toLowerCase(), nameTouched: true }))
          }
        />
      </Field>
      <Field
        label="Description"
        htmlFor={descriptionId}
        optional
        help="Agents see this when they list templates: say what the account is for."
        error={errors['description']}
      >
        <Textarea
          id={descriptionId}
          value={draft.description}
          maxLength={500}
          rows={3}
          placeholder="The recruiter account on LinkedIn and Indeed. Read-only research, no messages."
          onChange={(event) => onDraft((d) => ({ ...d, description: event.target.value }))}
        />
      </Field>
    </div>
  );
}
