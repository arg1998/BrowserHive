/** @module features/templates/detail/HeaderRelogin — the template header's sign-in controls (spec 13 §8.4, §11.4): **Show window** while a re-login window is queued or open (or a recording window pauses agents), **Sign in in the live view** instead for a re-login signed in through the live view, and the **Re-login** menu with one item per site (its health beside it) */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { LiveViewLink, liveViewSession, useShowWindow } from '../LiveViewSignIn.tsx';
import { needsSignIn } from '../model.ts';
import { reloginWindowPending } from '../relogin-text.ts';
import { HealthIcon } from '../SiteChips.tsx';

/** Show window + Re-login menu. Nothing while the template is still being set up. */
export function HeaderRelogin({
  detail,
  onRelogin,
}: {
  readonly detail: TemplateDetailResponse;
  readonly onRelogin: (site: string) => void;
}) {
  const { template } = detail;
  const showWindow = useShowWindow(template.template_id, detail.relogin);
  if (template.status === 'recording') return null;
  const showable = reloginWindowPending(detail.relogin) || detail.host.agents_paused;
  const live = liveViewSession(detail.relogin);
  const anyOut = detail.sites.some((s) => s.enabled && needsSignIn(s.health.state));
  return (
    <>
      {live !== null ? (
        <LiveViewLink sessionId={live} />
      ) : showable ? (
        <Hint label={`Brings the sign-in window to the front on ${detail.machine.name}`}>
          <Button type="button" size="sm" disabled={showWindow.pending} onClick={showWindow.show}>
            {showWindow.pending ? <Spinner /> : <ICONS.external aria-hidden="true" />}
            Show window
          </Button>
        </Hint>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant={anyOut && !showable ? 'default' : 'outline'}
              disabled={template.status === 'disabled'}
            />
          }
        >
          <ICONS.signIn aria-hidden="true" />
          Re-login
          <ICONS.chevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sign in again to</DropdownMenuLabel>
            {detail.sites.map((site) => (
              <DropdownMenuItem key={site.site_id} onClick={() => onRelogin(site.site_id)}>
                <HealthIcon state={site.health.state} />
                <span className="min-w-0 flex-1 truncate">{site.title}…</span>
                <span className="ml-3 text-xs text-muted-foreground">
                  {SITE_HEALTH[site.health.state].label}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
