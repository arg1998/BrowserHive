/** @module features/templates/detail/TemplateHeader — the template's title (display name, status pill), its agent-facing name with copy, a facts line (owner · channel · headed · created), the Browser's state with Start / Stop / Restart, Continue sign-in while setting up, and an overflow menu with Disable… / Enable and Delete… (spec 13 §11.4) */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { useNavigate } from '@tanstack/react-router';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { CHANNEL_LABEL, pagesText } from '../model.ts';
import { useTemplateActions } from '../use-template-actions.ts';

/** The Browser block: state, agent pages and the start/stop/restart controls. */
function BrowserControls({
  detail,
  onHost,
  busy,
}: {
  readonly detail: TemplateDetailResponse;
  readonly onHost: (action: 'start' | 'stop' | 'restart') => void;
  readonly busy: boolean;
}) {
  const { host } = detail;
  const pages = pagesText(host.state, host.pages);
  const up = host.state === 'running' || host.state === 'starting' || host.state === 'draining';
  const disabled = detail.template.status === 'disabled';
  const Play = ICONS.play;
  const Stop = ICONS.stopSquare;
  const Restart = ICONS.refresh;
  return (
    <>
      {/* The browser's state takes its own line on phones; its buttons share the next with the menu. Below 1280 px the actions sit under the title so the description never truncates. */}
      <span className="mr-1 flex min-w-0 basis-full items-center gap-1.5 text-sm sm:basis-auto">
        <span className="text-muted-foreground">Browser</span>
        <StatusBadge domain="templateHost" value={host.state} />
        {pages !== null ? <span className="text-muted-foreground">· {pages}</span> : null}
      </span>
      {up ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || host.state !== 'running'}
            onClick={() => onHost('restart')}
          >
            <Restart aria-hidden="true" />
            Restart
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onHost('stop')}
          >
            <Stop aria-hidden="true" />
            Stop
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || disabled}
          onClick={() => onHost(host.state === 'failed' ? 'restart' : 'start')}
        >
          {busy ? <Spinner /> : <Play aria-hidden="true" />}
          {host.state === 'failed' ? 'Restart' : 'Start'}
        </Button>
      )}
    </>
  );
}

/** Header. */
export function TemplateHeader({ detail }: { readonly detail: TemplateDetailResponse }) {
  const { template } = detail;
  const navigate = useNavigate();
  const actions = useTemplateActions(template);
  const More = ICONS.more;
  const SignIn = ICONS.signIn;
  // Separators are drawn before each item and clipped at the start of a line (as on the session
  // page), so a wrap never leaves a dangling "·".
  const meta = (
    <span className="-my-1 flex w-full min-w-0 overflow-hidden py-1">
      <span className="-ml-5 flex min-w-0 flex-wrap items-center gap-y-1 [&>*]:relative [&>*]:pl-5 [&>*]:before:absolute [&>*]:before:left-2 [&>*]:before:text-subtle-foreground [&>*]:before:content-['·']">
        <span className="inline-flex max-w-full min-w-0 items-center gap-0.5" data-reveal-scope="">
          <span className="truncate font-mono text-sm text-foreground/85">{template.name}</span>
          <CopyButton value={template.name} label="Copy template name" visibility="always" />
        </span>
        <span>{template.owner}</span>
        <span>
          {CHANNEL_LABEL[template.channel]} · {template.headless ? 'headless' : 'headed'}
        </span>
        <span className="inline-flex items-center gap-1">
          created <RelativeTime at={template.created_at} className="min-w-0 text-sm" />
        </span>
      </span>
    </span>
  );
  return (
    <PageHeader
      actionsBelowXl
      title={template.display_name}
      badge={<StatusBadge domain="templateStatus" value={template.status} variant="pill" />}
      {...(template.description !== '' && { description: template.description })}
      meta={meta}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {template.status === 'recording' ? (
            <Button type="button" size="sm" onClick={actions.continueSignIn}>
              <SignIn aria-hidden="true" />
              Continue sign-in
            </Button>
          ) : null}
          <BrowserControls
            detail={detail}
            busy={actions.busy}
            onHost={(action) => void actions.host(action)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${template.display_name}`}
                  disabled={actions.busy}
                />
              }
            >
              <More aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
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
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  void actions.remove().then((deleted) => {
                    if (deleted) void navigate({ to: '/templates' });
                  });
                }}
              >
                <ICONS.delete aria-hidden="true" />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  );
}
