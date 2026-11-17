/** @module features/templates/detail/ClipboardPanel — the Clipboard panel of the Settings tab (spec 13 §2.1, §13 "The operator's desktop"; D18): "Deny clipboard writes", off by default, saved at once with If-Match and applied to a running browser without a restart */
import type { Template } from '@browserhive/contracts/http';
import { useId } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Field } from './settings-field.tsx';
import { useSaveTemplate } from './use-save-template.ts';

/** Clipboard panel. */
export function ClipboardPanel({ template }: { readonly template: Template }) {
  const { save, saving } = useSaveTemplate(template);
  const switchId = useId();
  const hintId = useId();
  const deny = template.deny_clipboard_writes;
  return (
    <Panel
      title="Clipboard"
      description="What pages in this browser may do with the clipboard of the machine it runs on."
    >
      <div className="flex flex-col gap-5">
        <Field label="Deny clipboard writes" htmlFor={switchId}>
          <div className="flex items-center gap-3 sm:pt-1.5">
            <Switch
              id={switchId}
              checked={deny}
              disabled={saving}
              aria-describedby={hintId}
              onCheckedChange={(on: boolean) =>
                void save(
                  { deny_clipboard_writes: on },
                  on ? 'Clipboard writes denied' : 'Clipboard writes allowed',
                )
              }
            />
            <span className="text-base">
              {deny ? 'On: pages can’t write your clipboard' : 'Off'}
            </span>
          </div>
          <p id={hintId} className="text-sm text-muted-foreground">
            A page an agent clicks can put its own text on your clipboard, or change what you copy.
            With this on, it can’t, and your own copy still works. Applies at once.
          </p>
          {deny ? (
            <Callout tone="info" className="mt-1">
              Sites can tell, and their own Copy buttons stop working, also when you click them.
            </Callout>
          ) : null}
        </Field>
      </div>
    </Panel>
  );
}
