/** @module features/templates/TemplateMenu — a template's overflow menu (list rows and cards, spec 13 §11.4): Open, Continue sign-in (setting up), Restart browser, Disable… / Enable, Delete… */
import type { TemplateSummary } from '@browserhive/contracts/http';
import { useNavigate } from '@tanstack/react-router';
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
import { useTemplateActions } from './use-template-actions.ts';

/** Row menu. */
export function TemplateMenu({ template }: { readonly template: TemplateSummary }) {
  const navigate = useNavigate();
  const rowTabIndex = useRowControlTabIndex();
  const actions = useTemplateActions(template);
  const More = ICONS.more;
  const id = template.template_id;
  const running = template.host.state === 'running' || template.host.state === 'draining';
  return (
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
        ) : null}
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
  );
}
