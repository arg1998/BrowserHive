/** @module features/templates/detail/ClipboardPanel — the Clipboard panel of the Settings tab (spec 13 §2.1, §13 "The operator's desktop"; D18): "Deny clipboard writes", off by default, saved at once with If-Match; a running browser takes it at once, and when pages that were already open need a browser restart for full effect the panel says so and offers the restart */
import type { HostView, Template } from '@browserhive/contracts/http';
import { useId } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { useTemplateActions } from '../use-template-actions.ts';
import { Field } from './settings-field.tsx';
import { useSaveTemplate } from './use-save-template.ts';

/** The restart callout: what pages already open still do, and the restart that ends it. */
function RestartCallout({ template }: { readonly template: Template }) {
  const actions = useTemplateActions(template);
  return (
    <Callout tone="warn" className="mt-1" title="Restart the browser for full effect">
      <p>
        {template.deny_clipboard_writes
          ? 'Pages that were already open could still write your clipboard until the browser restarts. Restarting closes this template’s live sessions.'
          : 'Pages that were already open keep refusing to copy until they reload, and frames from other sites in those tabs until the browser restarts.'}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-2"
        disabled={actions.busy}
        onClick={() => void actions.host('restart')}
      >
        Restart browser
      </Button>
    </Callout>
  );
}

/** Clipboard panel. */
export function ClipboardPanel({
  template,
  host,
}: {
  readonly template: Template;
  readonly host: HostView;
}) {
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
            With this on, it can’t, and your own copy still works. Pages opened from now on are
            covered at once; pages already open are fully covered after a browser restart.
          </p>
          {host.clipboard_needs_restart === true ? <RestartCallout template={template} /> : null}
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
