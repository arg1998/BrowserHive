/** @module features/templates/TemplateMenu — a template's overflow menu (list rows and cards, spec 13 §11.4): Open, Continue sign-in (setting up), Re-login… (the dialog reads the template's sites when it opens), Restart browser, Disable… / Enable, Delete… */
import type { TemplateSummary } from '@browserhive/contracts/http';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useRowControlTabIndex } from '@/components/shared/row-context.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useTemplateDetail } from './api.ts';
import { expectsLiveView } from './LiveViewSignIn.tsx';
import { needsSignIn } from './model.ts';
import { ReloginDialog } from './ReloginDialog.tsx';
import { useTemplateActions } from './use-template-actions.ts';

/** Re-login… from a list row: the template's sites and machine are read once the dialog opens. */
function RowReloginDialog({
  templateId,
  site,
  onClose,
}: {
  readonly templateId: string;
  readonly site: string | null;
  readonly onClose: () => void;
}) {
  const detail = useTemplateDetail(site === null ? undefined : templateId);
  if (detail.data === undefined) return null;
  return (
    <ReloginDialog
      templateId={templateId}
      sites={detail.data.sites}
      machineName={detail.data.machine.name}
      site={site}
      onClose={onClose}
      liveView={expectsLiveView(detail.data)}
    />
  );
}

/** Row menu. */
export function TemplateMenu({ template }: { readonly template: TemplateSummary }) {
  const navigate = useNavigate();
  const rowTabIndex = useRowControlTabIndex();
  const actions = useTemplateActions(template);
  const More = ICONS.more;
  const id = template.template_id;
  const running = template.host.state === 'running' || template.host.state === 'draining';
  const [relogin, setRelogin] = useState<string | null>(null);
  const out = template.sites.filter((s) => needsSignIn(s.health_state));
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${template.display_name}`}
              tabIndex={rowTabIndex}
              disabled={actions.busy}
            />
          }
        >
          <More aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem onClick={() => void navigate({ to: '/templates/$id', params: { id } })}>
            <ICONS.arrowUpRight aria-hidden="true" />
            Open
          </DropdownMenuItem>
          {template.status === 'recording' ? (
            <DropdownMenuItem onClick={actions.continueSignIn}>
              <ICONS.signIn aria-hidden="true" />
              Continue sign-in
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={template.status === 'disabled'}
              onClick={() =>
                setRelogin(
                  out.length === 1
                    ? (out[0]?.site_id ?? '')
                    : template.sites.length === 1
                      ? (template.sites[0]?.site_id ?? '')
                      : '',
                )
              }
            >
              <ICONS.signIn aria-hidden="true" />
              Re-login…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {running || template.host.state === 'failed' || template.host.state === 'crashed' ? (
            <DropdownMenuItem onClick={() => void actions.host('restart')}>
              <ICONS.refresh aria-hidden="true" />
              Restart browser
            </DropdownMenuItem>
          ) : null}
          {template.status === 'disabled' ? (
            <DropdownMenuItem onClick={() => void actions.enable()}>
              <ICONS.play aria-hidden="true" />
              Enable
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => void actions.disable()}>
              <ICONS.pause aria-hidden="true" />
              Disable…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onClick={() => void actions.remove()}>
            <ICONS.delete aria-hidden="true" />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RowReloginDialog templateId={id} site={relogin} onClose={() => setRelogin(null)} />
    </>
  );
}
