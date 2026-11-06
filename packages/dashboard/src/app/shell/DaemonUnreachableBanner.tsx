/** @module app/shell/DaemonUnreachableBanner — the strip under the topbar once the daemon stops answering (04 §18.7): "Can't reach BrowserHive at host", a **What to do** dialog with the offline page's explanation and copyable commands, and the permanent status region that announces it. Never modal: the page stays readable. */
import { type ReactNode, useId, useMemo, useState } from 'react';
import { CodeBlock } from '@/components/shared/CodeBlock.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import {
  type DaemonHelp,
  daemonHelp,
  detectPlatform,
  groupByPurpose,
  type HelpCommand,
  helpCommandsFor,
} from '@/lib/daemon-help/commands.ts';
import { type Segment, stateCopy } from '@/lib/daemon-help/copy.ts';
import { LAST_SEEN_KEY, parseLastSeen } from '@/lib/daemon-help/keys.ts';
import type { ProbeState } from '@/lib/daemon-help/probe.ts';
import { useDaemonReachability } from '@/lib/daemon-help/reachability.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { readStorageJson } from '@/lib/storage.ts';
import { cn } from '@/lib/utils.ts';
import { AuthRetryBanner } from './AuthRetryNotice.tsx';

/** The banner's sentence, as announced (pure; exported for tests). */
export function bannerText(host: string): string {
  return `Can't reach BrowserHive at ${host}. It may have stopped.`;
}

/** The help for this page's address and this browser's OS. */
function currentHelp(): DaemonHelp {
  const nav = navigator as Navigator & { readonly userAgentData?: { readonly platform?: string } };
  return daemonHelp({
    location: window.location,
    platform: detectPlatform({ uaPlatform: nav.userAgentData?.platform, userAgent: nav.userAgent }),
    lastSeenVersion: readStorageJson(LAST_SEEN_KEY, parseLastSeen)?.version ?? null,
  });
}

const INLINE_CODE = 'rounded bg-muted px-1 py-px font-mono text-[0.9em] text-foreground';

function segments(parts: readonly Segment[]): ReactNode[] {
  return parts.map((part, i) =>
    typeof part === 'string' ? (
      part
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence; segments never reorder
      <code key={i} className={INLINE_CODE}>
        {part.code}
      </code>
    ),
  );
}

/**
 * Shown under the topbar while the daemon is unreachable; it takes the place of `AuthRetryBanner`
 * (the shell decides). Its dialog stays open, saying so, if the daemon comes back meanwhile.
 */
export function DaemonUnreachableBanner() {
  const { banner } = useDaemonReachability();
  const [open, setOpen] = useState(false);
  // The last state shown, so an open dialog does not lose its content when the banner hides.
  const [shown, setShown] = useState<ProbeState | null>(banner);
  if (banner !== null && banner !== shown) setShown(banner);
  const host = window.location.host;
  const Icon = ICONS.disconnect;
  return (
    <>
      {banner !== null ? (
        <div
          data-testid="daemon-unreachable-banner"
          className="sticky top-(--topbar-height) z-(--z-sticky) flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-danger-border bg-danger-bg px-gutter py-2 text-sm text-foreground backdrop-blur-md"
        >
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-danger-solid/15 text-danger-text"
          >
            <Icon className="size-3.5" />
          </span>
          <p className="min-w-0 flex-1 text-pretty">
            <span className="font-medium">
              Can't reach BrowserHive at <code className={INLINE_CODE}>{host}</code>.
            </span>{' '}
            <span className="text-muted-foreground">It may have stopped.</span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="bg-background/70"
            onClick={() => setOpen(true)}
          >
            What to do
          </Button>
        </div>
      ) : null}
      <WhatToDoDialog
        open={open && shown !== null}
        onOpenChange={setOpen}
        state={banner}
        lastState={shown ?? 'not-running'}
      />
    </>
  );
}

/** Under the topbar: the daemon-unreachable banner, or else the session-check retry banner (§6.1). */
export function ShellBanners() {
  const { banner } = useDaemonReachability();
  return (
    <>
      <DaemonUnreachableBanner />
      {banner === null ? <AuthRetryBanner /> : null}
    </>
  );
}

/** The permanent `role="status"` region; mounted once by the shell so the sentence is announced once. */
export function DaemonUnreachableAnnouncer() {
  const { banner } = useDaemonReachability();
  return (
    <div role="status" className="sr-only" data-testid="daemon-unreachable-status">
      {banner !== null ? bannerText(window.location.host) : ''}
    </div>
  );
}

function WhatToDoDialog({
  open,
  onOpenChange,
  state,
  lastState,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `null` once the daemon answers again. */
  readonly state: ProbeState | null;
  readonly lastState: ProbeState;
}) {
  // Read once per opening: the address and the OS do not change while it is open.
  const help = useMemo(() => (open ? currentHelp() : null), [open]);
  const back = state === null;
  const copy =
    help === null
      ? null
      : stateCopy(back ? lastState : state, {
          host: help.host,
          loopback: help.loopback,
          status: null,
        });
  const commands = help === null || back ? [] : helpCommandsFor(help, state);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false}>
        <DialogHeader className="flex-row items-start gap-3 pr-0">
          <span
            aria-hidden="true"
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl',
              back ? 'bg-success-bg text-success-text' : 'bg-danger-bg text-danger-text',
            )}
          >
            {back ? <ICONS.success className="size-5" /> : <ICONS.disconnect className="size-5" />}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle>{back ? 'BrowserHive is back' : (copy?.heading ?? '')}</DialogTitle>
            <DialogDescription className="text-pretty">
              {back
                ? 'The dashboard reconnected by itself. You can close this.'
                : segments(copy?.body ?? [])}
            </DialogDescription>
          </div>
        </DialogHeader>
        {help !== null && commands.length > 0 ? (
          <DialogBody className="flex min-w-0 flex-col gap-4 pb-1">
            <Commands help={help} commands={commands} />
          </DialogBody>
        ) : null}
        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <a
            href={docsUrl('troubleshootingNotRunning')}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'px-0')}
          >
            Learn more<span className="sr-only"> about BrowserHive not running</span>
            <ICONS.external aria-hidden="true" />
          </a>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Commands({
  help,
  commands,
}: {
  readonly help: DaemonHelp;
  readonly commands: readonly HelpCommand[];
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <h3 id={headingId} className="eyebrow">
        Commands
      </h3>
      {help.remoteNote !== null ? (
        <p className="rounded-lg border border-info-border bg-info-bg px-3 py-2 text-sm text-info-text">
          {help.remoteNote}
        </p>
      ) : null}
      <ul className="flex min-w-0 flex-col gap-4">
        {groupByPurpose(commands).map((group) => (
          <li key={group[0]?.id ?? ''} className="flex min-w-0 flex-col gap-1.5">
            <span className="section-label">{group[0]?.purpose}</span>
            {group.map((command) => (
              <div key={command.id} className="flex min-w-0 flex-col gap-1">
                {command.label !== null ? (
                  <span className="text-xs text-subtle-foreground">{command.label}</span>
                ) : null}
                <CodeBlock code={command.command} label={command.command} overflow="wrap" />
              </div>
            ))}
          </li>
        ))}
      </ul>
      <p className="text-sm text-pretty text-muted-foreground">{help.footer}</p>
    </section>
  );
}
