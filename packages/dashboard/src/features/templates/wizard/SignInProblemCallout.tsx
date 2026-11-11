/** @module features/templates/wizard/SignInProblemCallout — the sign-in step's error states (spec 13 §7.1), each with its copy and its action: no screen on the BrowserHive machine (the virtual-display command and the VNC guide), an unreachable proxy (its address and where to change it), no free browser slot, a browser that is not installed (the install command), no sandbox, a disabled template, and a browser that closed */
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { docsUrl } from '@/lib/links.ts';
import type { SignInProblem } from './sign-in-model.ts';

function Command({ text }: { readonly text: string }) {
  return (
    <span className="mt-1.5 flex max-w-full items-center gap-1 rounded-md bg-background/70 py-1 pr-1 pl-2.5 dark:bg-black/20">
      <code className="min-w-0 flex-1 truncate font-mono text-sm">{text}</code>
      <CopyButton value={text} label="Copy command" visibility="always" />
    </span>
  );
}

function DocLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
    >
      {children}
    </a>
  );
}

/** One error state. `onRetry` opens the window again. */
export function SignInProblemCallout({
  problem,
  templateId,
  onRetry,
  retrying,
}: {
  readonly problem: SignInProblem;
  readonly templateId: string;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}) {
  const retry = (
    <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
      Try again
    </Button>
  );
  switch (problem.kind) {
    case 'no_display':
      return (
        <Callout tone="danger" title="There’s no screen on the BrowserHive machine" action={retry}>
          <p>
            The sign-in window needs a desktop session where BrowserHive runs. On a server, run it
            under a virtual display and connect a VNC viewer to sign in.{' '}
            <DocLink href={docsUrl('templatesVnc')}>Signing in on a server</DocLink>
          </p>
          <Command text="xvfb-run -a browserhive serve --admin" />
        </Callout>
      );
    case 'proxy_unreachable':
      return (
        <Callout
          tone="danger"
          title="The template’s proxy didn’t answer"
          action={
            <>
              <Link
                to="/templates/$id"
                params={{ id: templateId }}
                search={{ tab: 'settings' }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Change the proxy
              </Link>
              {retry}
            </>
          }
        >
          {problem.proxy !== null ? (
            <>
              BrowserHive could not connect to{' '}
              <code className="font-mono text-sm">{problem.proxy}</code> from its machine, and never
              falls back to its own address. Check that the proxy runs.
            </>
          ) : (
            'BrowserHive could not connect to the proxy from its machine. Check that it runs.'
          )}
        </Callout>
      );
    case 'session_limit':
      return (
        <Callout
          tone="warn"
          title="No browser slot is free"
          action={
            <>
              <Link
                to="/sessions"
                search={{ view: 'live' }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Live sessions
              </Link>
              {retry}
            </>
          }
        >
          Every browser BrowserHive may run is in use. Close a session, or raise the limit with{' '}
          <code className="font-mono text-sm">--maxSessions</code>.
        </Callout>
      );
    case 'not_installed':
      return (
        <Callout tone="danger" title="This template’s browser isn’t installed" action={retry}>
          <p>Install it on the BrowserHive machine, then try again.</p>
          <Command text={problem.command ?? 'browserhive init'} />
        </Callout>
      );
    case 'sandbox':
      return (
        <Callout
          tone="danger"
          title="The browser can’t start sandboxed on this machine"
          action={retry}
        >
          BrowserHive runs with <code className="font-mono text-sm">sandbox=on</code>, and
          Chromium’s sandbox is unavailable here.{' '}
          <DocLink href={docsUrl('securitySandbox')}>The browser sandbox</DocLink>
        </Callout>
      );
    case 'disabled':
      return (
        <Callout
          tone="warn"
          title="This template is disabled"
          action={
            <Link
              to="/templates/$id"
              params={{ id: templateId }}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Open the template
            </Link>
          }
        >
          Enable it on its page to sign in.
        </Callout>
      );
    case 'crashed':
      return (
        <Callout
          tone="warn"
          title="The browser closed"
          action={
            <Button type="button" size="sm" disabled={retrying} onClick={onRetry}>
              Reopen it
            </Button>
          }
        >
          Sign-ins you finished are kept. Reopen the window to continue.
        </Callout>
      );
    case 'other':
      return (
        <Callout tone="danger" title="The sign-in window didn’t open" action={retry}>
          {problem.message}
          {problem.code !== null ? (
            <span className="ml-1 font-mono text-xs text-muted-foreground">{problem.code}</span>
          ) : null}
        </Callout>
      );
  }
}
