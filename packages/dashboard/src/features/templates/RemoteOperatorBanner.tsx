/** @module features/templates/RemoteOperatorBanner — the remote-operator notice of every action that opens a window on the BrowserHive machine (spec 13 §3.11): shown when this dashboard reaches BrowserHive at an address that is not this device, with the VNC hint for a server without a screen */
import { Callout } from '@/components/shared/Callout.tsx';
import { docsUrl } from '@/lib/links.ts';
import { remoteHost } from './model.ts';

/** The machine BrowserHive runs on when it is not this device (`null` on a loopback address). */
export function useRemoteHost(): string | null {
  return typeof window === 'undefined' ? null : remoteHost(window.location);
}

/** Notice; renders nothing for a local operator. `host` overrides the detected machine (tests). */
export function RemoteOperatorBanner({
  host,
  action = 'This opens a window',
}: {
  readonly host?: string | null;
  /** What the action does, for the sentence ("Re-login opens a window"). */
  readonly action?: string;
}) {
  const detected = useRemoteHost();
  const machine = host === undefined ? detected : host;
  if (machine === null) return null;
  return (
    <Callout tone="info" title={`${action} on ${machine}, not on this device`}>
      <p>
        Sign in where BrowserHive runs: at that machine’s screen, or through a remote desktop to it.
        On a server without a screen, connect a VNC viewer to its virtual display first.{' '}
        <a
          href={docsUrl('templatesVnc')}
          target="_blank"
          rel="noreferrer"
          className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
        >
          Signing in on a server
        </a>
      </p>
    </Callout>
  );
}
